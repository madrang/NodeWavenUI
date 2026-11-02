/**
 * Chat session persistence: one file per session under the workspace folder.
 * A plain workspace stores readable JSON. A password-protected workspace seals every file with a
 * random chat key that the settings storage holds, so the files stay closed without the password.
 */

import type { ChatImage, ToolCall } from '../providers/provider.js';
import {
  base64ToBytes,
  bytesToBase64,
  importRawAesKey,
  openRecord,
  randomBytes,
  sealRecord,
  type EncryptionKey,
} from '../storage/encryption.js';
import { fileSystem, joinPath, listDirectoryNames, readTextFile } from './file-system.js';
import type { WorkspaceSettingsStore } from './settings-store.js';

/** The folder of the session files, inside the workspace folder. */
const CHATS_FOLDER = 'chats';

/** The byte length of the chat key. AES-256 reads 32 bytes. */
const CHAT_KEY_BYTES = 32;

/**
 * The suite id every session file envelope seals with. Both AES-GCM suites share the same cipher
 * pair, and a raw-imported key needs no derivation, so the id only names the cipher.
 */
const FILE_SUITE = 'aes-gcm+pbkdf2' as const;

/** The session ids the file names accept: letters, digits, and dashes, so no path escapes the folder. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** The roles one stored entry may carry. */
const CHAT_ENTRY_ROLES = ['user', 'assistant', 'notice', 'error', 'tool'] as const;

/** One rendered chat entry. */
export interface ChatEntry {
  readonly role: (typeof CHAT_ENTRY_ROLES)[number];
  readonly content: string;
  /** The structured payload that a tool entry renders with the JSON viewer, when present. */
  readonly json?: unknown;
  /** The reasoning of an assistant reply, when the model reports one. It replays on the next request. */
  readonly reasoning?: string;
  /** The tool calls of an assistant reply, when the model requests tools instead of text. */
  readonly toolCalls?: readonly ToolCall[];
  /** The tool call this entry answers, on role tool. */
  readonly toolCallId?: string;
  /** The display name of the tool that produced this entry, on tool replies. */
  readonly toolName?: string;
  /** The images of the entry: attachments on user entries, image results on tool entries. */
  readonly images?: readonly ChatImage[];
  /** The short MCP session id that produced this entry, on entries of the host tab. */
  readonly mcpSession?: string;
  /** True while a user message waits for the running agent turn to finish. The next request skips it until then. */
  readonly queued?: boolean;
}

/** One persisted chat session: the durable state of one chat tab. */
export interface StoredChatSession {
  /** The session id, which is also the file name. */
  readonly id: string;
  readonly title: string;
  /** ISO date and time of the chat creation. It fixes the restore order. */
  readonly createdAt: string;
  readonly entries: readonly ChatEntry[];
  /** The provider the chat bound on its first send, when it sent one. */
  readonly boundProviderId?: string;
  /** The model the chat bound on its first send, when it sent one. */
  readonly boundModel?: string;
  /** The context tokens of the last request, when the provider reported usage. */
  readonly contextTokens?: number;
  /** The output tokens of the whole chat, summed over the requests the provider reported. */
  readonly outputTokens?: number;
}

/** Reads one stored tool call. Returns null on an invalid shape. */
function readToolCall(value: unknown): ToolCall | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.arguments !== 'string') {
    return null;
  }
  return { id: candidate.id, name: candidate.name, arguments: candidate.arguments };
}

/** Reads one stored image. Returns null on an invalid shape. */
function readChatImage(value: unknown): ChatImage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.data !== 'string' || typeof candidate.mimeType !== 'string') {
    return null;
  }
  return { data: candidate.data, mimeType: candidate.mimeType };
}

/**
 * Reads one stored entry.
 *
 * @param value The value to check. It can have any type.
 * @returns The entry, or null when one field carries a wrong type.
 */
function readChatEntry(value: unknown): ChatEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const role = CHAT_ENTRY_ROLES.find((entryRole) => entryRole === candidate.role);
  if (role === undefined || typeof candidate.content !== 'string') {
    return null;
  }
  const reasoning = candidate.reasoning;
  const toolCallId = candidate.toolCallId;
  const toolName = candidate.toolName;
  const mcpSession = candidate.mcpSession;
  const queued = candidate.queued;
  const toolCalls = Array.isArray(candidate.toolCalls)
    ? candidate.toolCalls.map((call) => readToolCall(call))
    : undefined;
  const images = Array.isArray(candidate.images) ? candidate.images.map((image) => readChatImage(image)) : undefined;
  if (
    (reasoning !== undefined && typeof reasoning !== 'string') ||
    (toolCallId !== undefined && typeof toolCallId !== 'string') ||
    (toolName !== undefined && typeof toolName !== 'string') ||
    (mcpSession !== undefined && typeof mcpSession !== 'string') ||
    (queued !== undefined && typeof queued !== 'boolean') ||
    (toolCalls !== undefined && toolCalls.some((call) => call === null)) ||
    (images !== undefined && images.some((image) => image === null))
  ) {
    return null;
  }
  return {
    role,
    content: candidate.content,
    ...(candidate.json !== undefined ? { json: candidate.json } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(toolCalls !== undefined ? { toolCalls: toolCalls as readonly ToolCall[] } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(images !== undefined ? { images: images as readonly ChatImage[] } : {}),
    ...(mcpSession !== undefined ? { mcpSession } : {}),
    ...(queued !== undefined ? { queued } : {}),
  };
}

/**
 * Reads one stored chat session.
 * A session with one damaged entry reads as null, whole, so a restored conversation never
 * loses the tool results that answer its tool calls.
 *
 * @param value The value to check. It can have any type.
 * @returns The session, or null when the record carries an invalid shape.
 */
export function readStoredChatSession(value: unknown): StoredChatSession | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    typeof candidate.title !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    candidate.createdAt.length === 0 ||
    !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  const entries: ChatEntry[] = [];
  for (const entry of candidate.entries) {
    const read = readChatEntry(entry);
    if (read === null) {
      return null;
    }
    entries.push(read);
  }
  const boundProviderId = candidate.boundProviderId;
  const boundModel = candidate.boundModel;
  const contextTokens = candidate.contextTokens;
  const outputTokens = candidate.outputTokens;
  if (
    (boundProviderId !== undefined && typeof boundProviderId !== 'string') ||
    (boundModel !== undefined && typeof boundModel !== 'string') ||
    (contextTokens !== undefined && typeof contextTokens !== 'number') ||
    (outputTokens !== undefined && typeof outputTokens !== 'number')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    title: candidate.title,
    createdAt: candidate.createdAt,
    entries,
    ...(boundProviderId !== undefined ? { boundProviderId } : {}),
    ...(boundModel !== undefined ? { boundModel } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** The stored form of the chat key: a version, the file cipher, and the base64 key bytes. */
interface ChatKeyRecord {
  readonly v: 1;
  readonly cipher: 'aes-256-gcm';
  readonly key: string;
}

/**
 * Reads one chat key record.
 *
 * @param value The value to check. It can have any type.
 * @returns The record, or null when it carries an invalid shape or a wrong key length.
 */
function readChatKeyRecord(value: unknown): ChatKeyRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1 || candidate.cipher !== 'aes-256-gcm' || typeof candidate.key !== 'string') {
    return null;
  }
  try {
    if (base64ToBytes(candidate.key).length !== CHAT_KEY_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return { v: 1, cipher: 'aes-256-gcm', key: candidate.key };
}

/** Reads and writes the chat session files of one workspace. */
export class ChatSessionStore {
  private readonly chatsPath: string;
  private readonly store: WorkspaceSettingsStore;
  private readonly encrypted: boolean;
  /** The imported chat key, set after init on an encrypted workspace. A null key on one blocks every save. */
  private fileKey: EncryptionKey | null = null;
  /** The save chain, so one slow seal never interleaves with the next write. */
  private writes: Promise<void> = Promise.resolve();

  /**
   * @param directoryPath The absolute path of the workspace directory.
   * @param store The settings store of the workspace, which holds the chat key.
   * @param encrypted True when the storage setup protects the workspace with a password.
   */
  constructor(directoryPath: string, store: WorkspaceSettingsStore, encrypted: boolean) {
    this.chatsPath = joinPath(directoryPath, CHATS_FOLDER);
    this.store = store;
    this.encrypted = encrypted;
  }

  /**
   * Loads the chat key of an encrypted workspace, or creates and stores a fresh one.
   * A damaged record logs a warning and is replaced: the old session files then fail to open and drop.
   * A storage failure disables the persistence, so an encrypted workspace never writes plain files.
   */
  async init(): Promise<void> {
    if (!this.encrypted) {
      return;
    }
    let raw: string | null = null;
    try {
      raw = await this.store.loadChatKey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the chat key could not be read. The chat sessions stay in memory: ${message}`);
      return;
    }
    let record = raw === null ? null : readChatKeyRecord(safeParse(raw));
    if (raw !== null && record === null) {
      console.warn('[NodeWavenUI] the stored chat key carries an invalid shape. A new key is generated.');
    }
    if (record === null) {
      record = { v: 1, cipher: 'aes-256-gcm', key: bytesToBase64(randomBytes(CHAT_KEY_BYTES)) };
      try {
        await this.store.saveChatKey(JSON.stringify(record));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the chat key could not be stored. The chat sessions stay in memory: ${message}`);
        return;
      }
    }
    try {
      this.fileKey = await importRawAesKey(base64ToBytes(record.key));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the chat key could not be imported. The chat sessions stay in memory: ${message}`);
    }
  }

  /**
   * Loads every stored session, oldest first.
   * A file that is damaged, sealed with another key, or fails its shape check logs a warning and drops.
   *
   * @returns The sessions in creation order.
   */
  async loadSessions(): Promise<readonly StoredChatSession[]> {
    const names = listDirectoryNames(this.chatsPath);
    if (names === null) {
      return [];
    }
    const sessions: StoredChatSession[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
      if (!SESSION_ID_PATTERN.test(id)) {
        continue;
      }
      const text = readTextFile(joinPath(this.chatsPath, name));
      if (text === null) {
        console.warn(`[NodeWavenUI] the chat session file "${name}" could not be read. It is ignored.`);
        continue;
      }
      let plain: string;
      if (this.fileKey !== null) {
        try {
          plain = await openRecord(FILE_SUITE, this.fileKey, name, text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[NodeWavenUI] the chat session file "${name}" could not be opened. It is ignored: ${message}`);
          continue;
        }
      } else {
        plain = text;
      }
      // The file name is the session id, so a renamed or copied record cannot move a session elsewhere.
      const parsed = safeParse(plain);
      const session = readStoredChatSession(typeof parsed === 'object' && parsed !== null ? { ...parsed, id } : null);
      if (session === null) {
        console.warn(`[NodeWavenUI] the chat session file "${name}" carries an invalid shape. It is ignored.`);
        continue;
      }
      sessions.push(session);
    }
    sessions.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
    return sessions;
  }

  /**
   * Persists one session as its own file. The write joins the chain and never throws into the chat flow.
   *
   * @param session The session to persist.
   */
  saveSession(session: StoredChatSession): void {
    this.writes = this.writes.then(() => this.writeSession(session)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the chat session "${session.id}" could not be saved: ${message}`);
    });
  }

  /**
   * Removes the file of one session. The removal joins the chain, so it lands after the pending saves.
   *
   * @param id The session id.
   */
  deleteSession(id: string): void {
    this.writes = this.writes.then(() => this.removeSession(id)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the chat session "${id}" could not be removed: ${message}`);
    });
  }

  /** Writes one session file, plain or sealed with the chat key. */
  private async writeSession(session: StoredChatSession): Promise<void> {
    // An encrypted workspace without its key writes nothing: a plain file would leak the conversation.
    if (this.encrypted && this.fileKey === null) {
      return;
    }
    const fs = fileSystem();
    if (fs === null) {
      console.warn('[NodeWavenUI] the filesystem is not reachable, so the chat session was not saved.');
      return;
    }
    fs.mkdirSync(this.chatsPath, { recursive: true });
    const fileName = `${session.id}.json`;
    const json = JSON.stringify(session, null, 2);
    const contents =
      this.fileKey !== null ? await sealRecord(FILE_SUITE, this.fileKey, fileName, json) : `${json}\n`;
    fs.writeFileSync(joinPath(this.chatsPath, fileName), contents);
  }

  /** Removes one session file. A missing file counts as removed. */
  private removeSession(id: string): void {
    if (!SESSION_ID_PATTERN.test(id)) {
      return;
    }
    const fs = fileSystem();
    if (fs === null) {
      return;
    }
    fs.rmSync(joinPath(this.chatsPath, `${id}.json`), { force: true });
  }
}

/** Parses JSON and answers undefined on damage, so one bad record reads as absent. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
