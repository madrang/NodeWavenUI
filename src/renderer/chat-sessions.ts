/**
 * The chat session store of the workspace page: the client side of the store that lives in the
 * worker core. The session files sit in the workspace `chats/` folder under the worker, sealed
 * with the chat key of the settings storage. This proxy carries the load, save, and delete calls
 * through the core contract and offers the interface the main app always used.
 */

import { readBridge, type NodeWavenBridge } from '../shared/bridge.js';
import type { CoreChatEntry, CoreChatSession } from '../shared/core-api.js';
import { log } from './logger.js';

/** One rendered chat entry. */
export type ChatEntry = CoreChatEntry;

/** The system prompt a chat bound on its first send. */
export interface StoredSystemPrompt {
  /** The ids of the sources that built the prompt, in concatenation order. Empty for the none prompt. */
  readonly sourceIds: readonly string[];
  readonly title: string;
  readonly text: string;
}

/** One persisted chat session: the durable state of one chat tab. */
export type StoredChatSession = CoreChatSession;

/** The session store client of the workspace page. The files live under the worker core. */
export class ChatSessionStore {
  private readonly bridge: NodeWavenBridge | null;

  constructor() {
    this.bridge = readBridge();
  }

  /** The chat key lives in the worker core, so the init of the page side holds nothing to do. */
  async init(): Promise<void> {
    return;
  }

  /**
   * Loads every stored session, oldest first.
   *
   * @returns The sessions in creation order.
   * @throws Error when the core request fails.
   */
  async loadSessions(): Promise<readonly StoredChatSession[]> {
    const sessions = await this.request('chat.sessions.load');
    return Array.isArray(sessions) ? (sessions as StoredChatSession[]) : [];
  }

  /**
   * Persists one session as its own file, fire and forget like the local store was.
   *
   * @param session The session to persist.
   */
  saveSession(session: StoredChatSession): void {
    void this.request('chat.sessions.save', session).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.chatSessions.warning(`the chat session "${session.id}" could not be saved: ${message}`);
    });
  }

  /**
   * Removes the file of one session.
   *
   * @param id The session id.
   */
  deleteSession(id: string): void {
    void this.request('chat.sessions.delete', { id }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.chatSessions.warning(`the chat session "${id}" could not be removed: ${message}`);
    });
  }

  /** Runs one core request of the session contract. */
  private async request(channel: string, payload?: unknown): Promise<unknown> {
    if (!this.bridge) {
      throw new Error('The chat session store needs the nodewavenui bridge of an app window.');
    }
    return this.bridge.core.request(channel, payload);
  }
}
