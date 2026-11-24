/**
 * The chat client of the workspace page: the mirror of the chats the engine owns in the worker
 * core (`src/worker/chat-engine.ts`). It keeps one chat object per chat for the life of the chat
 * and applies the state changes the core pushes on `chat.event` in place, so a view that holds a
 * chat reads its changes. It carries every action of the composer and the message list through the
 * `chat.*` channels of the core contract, and offers the `Chat` the views always used.
 */

import type { NodeWavenBridge } from '../shared/bridge.js';
import type {
  CoreAgentToolInfo,
  CoreChat,
  CoreChatMeta,
  CoreChatPicks,
  CoreChatSend,
  CoreChatEvent,
} from '../shared/core-api.js';
import { readChatEvent, readChatState } from '../shared/core-api.js';
import type { ChatImage, ThinkingLevel } from '../providers/provider.js';
import type { TaskDispatchMode } from '../shared/tasks.js';
import type { Chat, ChatEditState } from './chat-render.js';
import type { ChatEntry } from './chat-sessions.js';
import { log } from './logger.js';

/** One chat state change the views render from. */
export type ChatChange =
  | { readonly kind: 'chat' | 'closed'; readonly chatId: number } |
  { readonly kind: 'entries'; readonly chatId: number } |
  { readonly kind: 'unread'; readonly chatId: number } |
  { readonly kind: 'meta'; readonly chatId: number; readonly runningChanged: boolean } |
  { readonly kind: 'delta'; readonly chatId: number; readonly entry: ChatEntry };

/** One change of the state or the entries of one chat: a pushed change minus the list changes. */
type CoreChatChange = Exclude<CoreChatEvent, { readonly kind: 'chat' } | { readonly kind: 'closed' }>;

/** Reads one whole chat the core answered. Returns null on an invalid shape. */
function readCoreChat(value: unknown): CoreChat | null {
  if (typeof value !== 'object' || !value) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'number' || !Array.isArray(candidate.entries) || typeof candidate.revision !== 'number') {
    return null;
  }
  return value as CoreChat;
}

/** Copies the state of one chat from the core onto its page view, the entries aside. */
function applyMeta(chat: Chat, meta: CoreChatMeta): void {
  if (meta.boundProviderId) {
    chat.boundProviderId = meta.boundProviderId;
  } else {
    delete chat.boundProviderId;
  }
  if (meta.boundModel) {
    chat.boundModel = meta.boundModel;
  } else {
    delete chat.boundModel;
  }
  if (meta.systemPrompt) {
    chat.boundSystemPrompt = meta.systemPrompt;
  } else {
    delete chat.boundSystemPrompt;
  }
  if (meta.thinkingLevel) {
    chat.thinkingLevel = meta.thinkingLevel;
  } else {
    delete chat.thinkingLevel;
  }
  if (meta.taskId) {
    chat.taskId = meta.taskId;
  } else {
    delete chat.taskId;
  }
  // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence clears the field
  if (meta.contextTokens !== undefined) {
    chat.contextTokens = meta.contextTokens;
  } else {
    delete chat.contextTokens;
  }
  // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence clears the field
  if (meta.outputTokens !== undefined) {
    chat.outputTokens = meta.outputTokens;
  } else {
    delete chat.outputTokens;
  }
}

/** Builds the page view of one chat of the core. */
function chatOf(core: CoreChat): Chat {
  const chat: Chat = {
    id: core.id,
    fileId: core.fileId,
    title: core.title,
    createdAt: core.createdAt,
    entries: [...core.entries],
  };
  applyMeta(chat, core);
  return chat;
}

/** The chat client of the workspace page. Every chat state lives in the worker core. */
export class ChatClient {
  private readonly bridge: NodeWavenBridge;
  private readonly isActive: (chatId: number) => boolean;
  /** The chat ids in creation order. */
  private readonly order: number[] = [];
  private readonly chats = new Map<number, Chat>();
  /** The last revision of each chat the mirror applied. */
  private readonly revisions = new Map<number, number>();
  private readonly running = new Set<number>();
  /** The chats a fresh whole read resyncs. Their pushed changes wait until the read lands. */
  private readonly resyncing = new Set<number>();
  /** The changes that arrived before their chat landed, or while it resyncs. They replay after. */
  private readonly waiting = new Map<number, CoreChatChange[]>();
  private readonly listeners = new Set<(change: ChatChange) => void>();

  /**
   * @param bridge The bridge of the workspace window.
   * @param isActive Reads whether one chat sits in the active tab. A background chat marks unread.
   */
  constructor(bridge: NodeWavenBridge, isActive: (chatId: number) => boolean) {
    this.bridge = bridge;
    this.isActive = isActive;
    bridge.workspace.onWorkspaceEvent('chat.event', (payload: unknown) => {
      const event = readChatEvent(payload);
      if (event) {
        this.receive(event);
      }
    });
  }

  /** Reads every chat of the core into the mirror. Call once at boot, before any view lists them. */
  async load(): Promise<void> {
    const state = readChatState(await this.request('chat.list'));
    if (!state) {
      throw new Error('The core answered the chat list with an invalid shape.');
    }
    for (const chat of state.chats) {
      if (readCoreChat(chat)) {
        this.install(chat, false);
      }
    }
  }

  /** Reads the chats in creation order. */
  list(): readonly Chat[] {
    return this.order.map((id) => this.chats.get(id)).filter((chat): chat is Chat => Boolean(chat));
  }

  /** Reads one chat, or null when the core holds none of that id. */
  get(chatId: number): Chat | null {
    return this.chats.get(chatId) ?? null;
  }

  /** True while one chat runs an agent turn. */
  isRunning(chatId: number): boolean {
    return this.running.has(chatId);
  }

  /** Subscribes to every state change of every chat. */
  subscribe(listener: (change: ChatChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Opens one fresh chat in the core and adds it to the mirror. */
  async create(): Promise<Chat> {
    const core = readCoreChat(await this.request('chat.create'));
    if (!core) {
      throw new Error('The core answered the new chat with an invalid shape.');
    }
    return this.install(core, false);
  }

  /** Closes one chat in the core. The pushed change removes it from the mirror. */
  async close(chatId: number): Promise<void> {
    await this.request('chat.close', { chatId });
  }

  /**
   * Delivers one message to a chat. A running turn queues it in the core.
   *
   * @param chat The chat that takes the message.
   * @param text The message text.
   * @param images The attachments of the message.
   * @param picks The connection picks of a first send.
   * @returns True when the message landed. False when a notice entry in the chat explains the refusal.
   */
  async send(chat: Chat, text: string, images: readonly ChatImage[], picks: CoreChatPicks): Promise<boolean> {
    const call: CoreChatSend = { chatId: chat.id, text, images, ...picks };
    return (await this.request('chat.send', call)) === true;
  }

  /** Lands one notice entry in one chat, for a refusal the composer explains in the transcript. */
  async notice(chatId: number, text: string): Promise<void> {
    await this.request('chat.notice', { chatId, text });
  }

  /** Lands one notification as a user message in one chat, or in the newest chat on a null id. */
  async notify(chatId: number | null, text: string): Promise<void> {
    await this.request('chat.notify', { chatId, text });
  }

  /** Stops the running turn of one chat. */
  async stop(chatId: number): Promise<void> {
    await this.request('chat.stop', { chatId });
  }

  /** Restarts the failed turn of one user message. */
  async retry(chatId: number, index: number): Promise<void> {
    await this.request('chat.retry', { chatId, index });
  }

  /** Copies the history before one user message into a new chat, and adds the fork to the mirror. */
  async fork(chatId: number, index: number): Promise<Chat | null> {
    const core = readCoreChat(await this.request('chat.fork', { chatId, index }));
    return core ? this.install(core, false) : null;
  }

  /** Sends the edited draft: the draft replaces the edited message, or appends as a fork draft. */
  async edit(editing: ChatEditState, text: string, picks: CoreChatPicks): Promise<void> {
    await this.request('chat.edit', {
      chatId: editing.chatId,
      ...(typeof editing.index === 'number' ? { index: editing.index } : {}),
      text,
      ...(editing.images ? { images: editing.images } : {}),
      ...picks,
    });
  }

  /** Sends one queued message at once. */
  async sendNow(chatId: number, index: number): Promise<void> {
    await this.request('chat.sendNow', { chatId, index });
  }

  /** Sets the reasoning effort of one chat. Null clears the pin. */
  async setThinking(chatId: number, level: ThinkingLevel | null): Promise<void> {
    await this.request('chat.thinking', { chatId, level });
  }

  /** Reads the tools of the chat agent for the settings matrix. */
  async tools(): Promise<readonly CoreAgentToolInfo[]> {
    const tools = await this.request('chat.tools');
    return Array.isArray(tools) ? (tools as CoreAgentToolInfo[]) : [];
  }

  /** Dispatches one queued task onto its session. The turn of the session runs on in the core. */
  async dispatch(id: string, mode: TaskDispatchMode, sessionFileId: string | null): Promise<string> {
    const outcome = await this.request('chat.dispatch', { id, mode, sessionFileId });
    return typeof outcome === 'string' ? outcome : '';
  }

  /** Returns one review to its session with the comment of the user. */
  async returnTask(id: string, comment: string | null): Promise<void> {
    await this.request('chat.task.return', { id, note: comment });
  }

  /** Applies one pushed change. */
  private receive(event: CoreChatEvent): void {
    if (event.kind === 'chat') {
      if (readCoreChat(event.chat)) {
        this.install(event.chat, false);
        this.emit({ kind: 'chat', chatId: event.chat.id });
      }
      return;
    }
    if (event.kind === 'closed') {
      this.waiting.delete(event.chatId);
      if (this.remove(event.chatId)) {
        this.emit({ kind: 'closed', chatId: event.chatId });
      }
      return;
    }
    // The remaining changes carry their chat in one of two shapes: a state change names it inside.
    const chatId = event.kind === 'meta' ? event.chat.id : event.chatId;
    const incoming = event.kind === 'meta' ? event.chat.revision : event.revision;
    const chat = this.chats.get(chatId);
    // A change of a chat the mirror holds not yet, or reads fresh, waits until the chat lands.
    if (!chat || this.resyncing.has(chatId)) {
      this.stash(event);
      return;
    }
    const revision = this.revisions.get(chatId) ?? 0;
    if (event.kind === 'delta') {
      // A piece of another revision is stale: the settled entry replaces its slot.
      if (incoming !== revision) {
        return;
      }
      const slot = chat.entries[event.index];
      if (!slot || slot.role !== 'assistant') {
        this.resync(chatId);
        return;
      }
      const next: ChatEntry = {
        ...slot,
        content: slot.content + (event.content ?? ''),
        ...(event.reasoning ? { reasoning: (slot.reasoning ?? '') + event.reasoning } : {}),
      };
      chat.entries[event.index] = next;
      this.markUnread(chat);
      this.emit({ kind: 'delta', chatId, entry: next });
      return;
    }
    // A repeated change, or one a whole read already carried, changes nothing.
    if (incoming <= revision) {
      return;
    }
    // A gap means the mirror missed a change: the chat reads whole before the later ones apply.
    if (incoming > revision + 1 || (event.kind === 'splice' && event.index > chat.entries.length)) {
      this.stash(event);
      this.resync(chatId);
      return;
    }
    this.revisions.set(chatId, incoming);
    if (event.kind === 'meta') {
      const wasRunning = this.running.has(chatId);
      applyMeta(chat, event.chat);
      this.setRunning(chatId, event.chat.running);
      this.emit({ kind: 'meta', chatId, runningChanged: wasRunning !== event.chat.running });
      return;
    }
    chat.entries.splice(event.index, event.remove, ...event.entries);
    this.markUnread(chat);
    this.emit({ kind: 'entries', chatId });
  }

  /** Lands one whole chat in the mirror: a new chat, or the fresh read of a held one. */
  private install(core: CoreChat, replace: boolean): Chat {
    const existing = this.chats.get(core.id);
    // A whole chat that is not newer than the applied changes is a repeat, for example the answer
    // of a create whose pushed change already landed.
    if (existing && !replace && core.revision <= (this.revisions.get(core.id) ?? 0)) {
      return existing;
    }
    let chat = existing;
    if (!chat) {
      chat = chatOf(core);
      this.chats.set(core.id, chat);
      this.order.push(core.id);
    } else {
      chat.entries.splice(0, chat.entries.length, ...core.entries);
      applyMeta(chat, core);
    }
    this.revisions.set(core.id, core.revision);
    this.setRunning(core.id, core.running);
    return chat;
  }

  /** Removes one chat from the mirror. False when the mirror held none. */
  private remove(chatId: number): boolean {
    if (!this.chats.delete(chatId)) {
      return false;
    }
    this.order.splice(this.order.indexOf(chatId), 1);
    this.revisions.delete(chatId);
    this.running.delete(chatId);
    this.resyncing.delete(chatId);
    return true;
  }

  /** Holds one change back until its chat lands. */
  private stash(event: CoreChatChange): void {
    const chatId = event.kind === 'meta' ? event.chat.id : event.chatId;
    const pending = this.waiting.get(chatId);
    if (pending) {
      pending.push(event);
    } else {
      this.waiting.set(chatId, [event]);
    }
  }

  /** Reads one chat whole in the core and applies it, then replays the changes that waited. */
  private resync(chatId: number): void {
    if (this.resyncing.has(chatId)) {
      return;
    }
    this.resyncing.add(chatId);
    void this.request('chat.get', { chatId })
      .then((value: unknown) => {
        this.resyncing.delete(chatId);
        const core = readCoreChat(value);
        if (!core) {
          // The core holds no chat of that id any more: it closed while its changes were in flight.
          this.waiting.delete(chatId);
          if (this.remove(chatId)) {
            this.emit({ kind: 'closed', chatId });
          }
          return;
        }
        this.install(core, true);
        // The fresh read stands for every change the mirror missed, so the views render it whole.
        this.emit({ kind: 'meta', chatId, runningChanged: true });
        this.emit({ kind: 'entries', chatId });
        const pending = this.waiting.get(chatId) ?? [];
        this.waiting.delete(chatId);
        for (const event of pending) {
          this.receive(event);
        }
      })
      .catch((error: unknown) => {
        this.resyncing.delete(chatId);
        const message = error instanceof Error ? error.message : String(error);
        log.chat.warning(`the chat ${chatId} could not be read fresh, its later changes stay buffered: ${message}`);
      });
  }

  /** Marks one chat unread when it sits in a background tab, and tells the views. */
  private markUnread(chat: Chat): void {
    if (this.isActive(chat.id) || chat.unread) {
      return;
    }
    chat.unread = true;
    this.emit({ kind: 'unread', chatId: chat.id });
  }

  /** Records whether one chat runs a turn. */
  private setRunning(chatId: number, running: boolean): void {
    if (running) {
      this.running.add(chatId);
    } else {
      this.running.delete(chatId);
    }
  }

  /** Fires every listener with one change. */
  private emit(change: ChatChange): void {
    for (const listener of this.listeners) {
      listener(change);
    }
  }

  /** Runs one core request of the chat contract. */
  private request(channel: string, payload?: unknown): Promise<unknown> {
    return this.bridge.core.request(channel, payload);
  }
}
