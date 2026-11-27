/**
 * The contract of the background core: the worker process that owns the app state, and the
 * channels every surface speaks with it. The framing is transport free: the renderer rides the
 * core slice of the bridge through the main process, and the remote control page rides HTTP with
 * its event stream. A channel enters the contract together with the worker case that serves it.
 */

import { isRecord } from './records.js';
import type { BridgePermissionCheck, ChatImageShape } from './bridge.js';
import { isPermissionRule, type PermissionRule } from './permissions.js';
import {
  isTaskStatus,
  readTaskPriority,
  type TaskConnection,
  type TaskRecord,
  type TaskStatus,
  type TaskTemplate,
} from './tasks.js';
import { readSystemPromptIds } from './system-prompts.js';

/** One request a surface sends to the core. The id ties the reply to the request. */
export interface CoreRequest {
  readonly id: number;
  readonly channel: string;
  readonly payload: unknown;
}

/** One reply the core answers a request with. */
export interface CoreReply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/** One event the core pushes to every connected surface. */
export interface CoreEvent {
  readonly channel: string;
  readonly payload: unknown;
}

/** The state of the worker as the main process sees it. Null means no worker runs. */
export interface CoreStatus {
  readonly state: 'starting' | 'ready' | 'failed';
  readonly error?: string;
}

/** Every request channel the contract defines. The worker serves the groups its phase landed. */
export const CORE_REQUEST_CHANNELS = [
  'settings.get',
  'settings.set',
  'settings.delete',
  'settings.keys',
  'permission.check',
  'permission.list',
  'permission.resolve',
  'permission.rule.add',
  'permission.rule.remove',
  'chat.sessions.load',
  'chat.sessions.save',
  'chat.sessions.delete',
  'chat.list',
  'chat.get',
  'chat.create',
  'chat.close',
  'chat.send',
  'chat.stop',
  'chat.retry',
  'chat.fork',
  'chat.edit',
  'chat.sendNow',
  'chat.thinking',
  'chat.notify',
  'chat.notice',
  'chat.tools',
  'chat.dispatch',
  'chat.task.return',
  'patch.list',
  'patch.propose',
  'patch.apply',
  'patch.deny',
  'patch.dismiss',
  'patch.delete',
  'patch.clear',
  'patch.task.set',
  'patch.task.close',
  'remote.config.get',
  'remote.config.save',
  'remote.token.show',
  'remote.token.renew',
  'remote.qr',
  'remote.password.set',
  'remote.password.clear',
  'task.list',
  'task.create',
  'task.dispatch',
  'task.next',
  'task.bind',
  'task.complete',
  'task.fail',
  'task.cancel',
  'task.accept',
  'task.return',
  'task.answer',
  'task.archive',
  'task.restore',
  'task.template.save',
  'task.template.remove',
  'task.reopen',
  'task.retry',
  'task.relink',
  'task.update',
  'task.remove',
] as const;

/** One request channel of the contract. */
export type CoreRequestChannel = (typeof CORE_REQUEST_CHANNELS)[number];

/** Every event channel the contract defines. */
export const CORE_EVENT_CHANNELS = [
  'core.state',
  'permission.event',
  'chat.event',
  'patch.event',
  'patch.notice',
  'task.event',
  'task.settle',
] as const;

/** One event channel of the contract. */
export type CoreEventChannel = (typeof CORE_EVENT_CHANNELS)[number];

/**
 * The storage setup ids the worker opens. The JSON file setups read and write through the fs
 * slice the worker owns. Every other setup id answers with a failure, because the legacy
 * IndexedDB setups die with the renderer profile they lived in.
 */
export const WORKER_STORAGE_IDS: readonly string[] = ['json', 'json-password'];

/** The startup data the worker opens its storage with. */
export interface WorkerStart {
  /** The absolute path of the workspace folder. */
  readonly directoryPath: string;
  /** The display name of the workspace marker. Empty when the start message carries none. */
  readonly name: string;
  /** The storage setup id of the workspace marker. */
  readonly storageId: string;
  /** The non-secret storage configuration of the workspace marker. */
  readonly storageConfig: unknown;
  /** The workspace password, or null when the setup needs none. */
  readonly password: string | null;
  /** The absolute path of the app root, for the static assets the remote server serves. */
  readonly appRoot: string;
  /** The exact workspace data version the launcher read in the marker at start. Undefined when the
   * marker carried none. The format migration of the core compares this version. */
  readonly dataVersion: string | undefined;
  /** The version of the running app, for the format migration of the core. */
  readonly appVersion: string;
}

/** What the main process sends to the worker. */
export type MainToWorkerMessage =
  | { readonly kind: 'start'; readonly start: WorkerStart } |
  { readonly kind: 'request'; readonly request: CoreRequest } |
  { readonly kind: 'callReply'; readonly reply: CoreReply } |
  { readonly kind: 'shutdown' };

/** One log record the worker forwards to the main process hierarchy. */
export interface WorkerLogRecord {
  /** The dotted child path of the logger under the worker root, for example "storage". */
  readonly name: string;
  /** The `EventLevels` value of the event. */
  readonly level: number;
  /** The rendered arguments of the event. */
  readonly args: readonly string[];
}

/** Every call channel the worker sends to the main process, for the services that stayed there:
 * the window and command tools, and the MCP client with its connections. */
export const MAIN_CALL_CHANNELS = ['windowTool', 'mcp.nativeTools', 'mcp.runNativeTool', 'mcp.readResource'] as const;

/** One call the worker sends to the main process. The id ties the reply to the call. */
export interface CoreMainCall {
  readonly id: number;
  readonly channel: (typeof MAIN_CALL_CHANNELS)[number];
  readonly payload: unknown;
}

/** What the worker sends to the main process. */
export type WorkerToMainMessage =
  | { readonly kind: 'ready' } |
  { readonly kind: 'failed'; readonly message: string } |
  { readonly kind: 'reply'; readonly reply: CoreReply } |
  { readonly kind: 'event'; readonly event: CoreEvent } |
  { readonly kind: 'log'; readonly record: WorkerLogRecord } |
  { readonly kind: 'call'; readonly call: CoreMainCall };

/**
 * Checks one value as a WorkerStart.
 * The start message crosses a process boundary, so the worker validates it before use.
 *
 * @param value The value to check. It can have any type.
 * @returns The start data, or null on an invalid shape.
 */
export function readWorkerStart(value: unknown): WorkerStart | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.directoryPath !== 'string' || typeof value.storageId !== 'string') {
    return null;
  }
  // Any falsy password value reads as no password, the same reading the storage layer holds.
  const password = typeof value.password === 'string' && value.password ? value.password : null;
  const appRoot = typeof value.appRoot === 'string' ? value.appRoot : '';
  return {
    directoryPath: value.directoryPath,
    name: typeof value.name === 'string' ? value.name : '',
    storageId: value.storageId,
    storageConfig: value.storageConfig,
    password,
    appRoot,
    dataVersion: typeof value.dataVersion === 'string' ? value.dataVersion : undefined,
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
  };
}

/** One pending permission ask of the gate, as every surface lists and renders it. */
export interface CorePendingPermission {
  /** The id the resolve call answers. */
  readonly id: number;
  readonly principal: string;
  readonly action: string;
  /** The target in human readable form, for example "window https://example.com". */
  readonly target: string;
  /** The command text of a run request, parsed for display. Null for every other target. */
  readonly command: string | null;
  /** The detail the caller attached, for example "child window 3 (https://example.com)". */
  readonly detail: string;
  readonly createdAt: number;
  /** The origin of the call, for example the MCP session id. Null when the caller gave none. */
  readonly source: string | null;
}

/** The full permission state of the core: the queued asks and the persisted rules. */
export interface CorePermissionState {
  readonly pending: readonly CorePendingPermission[];
  readonly rules: readonly PermissionRule[];
}

/**
 * Reads one `permission.check` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The check, or null on an invalid shape.
 */
export function readPermissionCheckPayload(value: unknown): BridgePermissionCheck | null {
  if (
    !isRecord(value) ||
    typeof value.principal !== 'string' ||
    typeof value.action !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.preauthorized !== 'boolean'
  ) {
    return null;
  }
  // Any falsy source value reads as no source, so only a string names one.
  const source = typeof value.source === 'string' ? value.source : null;
  return {
    principal: value.principal,
    action: value.action,
    target: value.target,
    description: value.description,
    source,
    preauthorized: value.preauthorized,
  };
}

/**
 * Reads one `permission.rule.add` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The rule, or null on an invalid shape.
 */
export function readPermissionRulePayload(value: unknown): PermissionRule | null {
  return isPermissionRule(value) ? value : null;
}

/** The resolve answer of one pending permission ask. */
export interface CorePermissionResolve {
  readonly id: number;
  readonly approve: boolean;
  /** True persists a rule beside resolving the ask. */
  readonly remember: boolean;
}

/** One chat entry as it crosses the core, the wire shape of the persisted entry. */
export interface CoreChatEntry {
  readonly role: 'user' | 'assistant' | 'notice' | 'error' | 'tool';
  readonly content: string;
  readonly json?: unknown;
  readonly reasoning?: string;
  /** The tool calls of an assistant reply, when the model requests tools instead of text. */
  readonly toolCalls?: readonly CoreToolCall[];
  /** The tool call this entry answers, on role tool. */
  readonly toolCallId?: string;
  /** The display name of the tool that produced this entry, on tool replies. */
  readonly toolName?: string;
  readonly images?: readonly ChatImageShape[];
  readonly mcpSession?: string;
  readonly queued?: boolean;
}

/** One tool call of an assistant reply, the wire shape of the provider type. */
export interface CoreToolCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as serialized JSON. */
  readonly arguments: string;
}

/** One chat session as it crosses the core, the wire shape of the stored session. */
export interface CoreChatSession {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly entries: readonly CoreChatEntry[];
  readonly boundProviderId?: string;
  readonly boundModel?: string;
  readonly contextTokens?: number;
  readonly outputTokens?: number;
  readonly systemPrompt?: CoreSystemPrompt;
  readonly thinkingLevel?: CoreThinkingLevel;
}

/** The reasoning effort levels a chat may pin. */
export type CoreThinkingLevel = 'low' | 'medium' | 'high';

/** One system prompt a chat bound on its first send. */
export interface CoreSystemPrompt {
  /** The ids of the sources that built the prompt, in concatenation order. Empty for the none prompt. */
  readonly sourceIds: readonly string[];
  readonly title: string;
  readonly text: string;
}

/** The state of one chat as every surface reads it, without its entries. */
export interface CoreChatMeta {
  readonly id: number;
  /** The session file id: one uuid per chat, stable across launches. */
  readonly fileId: string;
  readonly title: string;
  /** ISO date and time of the chat creation. It fixes the restore order. */
  readonly createdAt: string;
  /** The provider and model the chat bound on its first send. They stay for the life of the chat. */
  readonly boundProviderId?: string;
  readonly boundModel?: string;
  /** The context tokens of the last request, when the provider reported usage. */
  readonly contextTokens?: number;
  /** The output tokens of the whole chat, summed over the requests the provider reported. */
  readonly outputTokens?: number;
  /** The system prompt the chat bound on its first send. It stays for the life of the chat. */
  readonly systemPrompt?: CoreSystemPrompt;
  /** The reasoning effort of the chat. Unset follows the workspace default. */
  readonly thinkingLevel?: CoreThinkingLevel;
  /** The dispatchable task this chat runs, set when a dispatch bound it. */
  readonly taskId?: string;
  /** The draft task the chat was opened for. Its first send dispatches the task into the chat. Absent
   * once the task left the draft state, or once a send dispatched it. */
  readonly waitingTaskId?: string;
  /** True while an agent turn of the chat runs. */
  readonly running: boolean;
  /** Counts the state changes of the chat since the core opened it. A surface drops a change it
   * already holds, and a gap orders a fresh read of the chat. */
  readonly revision: number;
}

/** One chat as the core answers it whole: its state and its entries. */
export interface CoreChat extends CoreChatMeta {
  readonly entries: readonly CoreChatEntry[];
}

/** The `chat.list` answer: every chat of the core, in creation order. */
export interface CoreChatState {
  readonly chats: readonly CoreChat[];
}

/** One tool of the chat agent as the settings matrix lists it. */
export interface CoreAgentToolInfo {
  readonly name: string;
  readonly description: string;
}

/** One system prompt source as a surface lists it: the menu entry without its builder. */
export interface CoreSystemPromptSourceInfo {
  readonly id: string;
  readonly label: string;
}

/**
 * One chat state change the core pushes on `chat.event`. A new chat arrives whole, a change of its
 * state arrives without entries, a change of its entries arrives as one splice, and a streamed
 * piece arrives as the delta the surface appends to the entry at its index.
 */
export type CoreChatEvent =
  | { readonly kind: 'chat'; readonly chat: CoreChat } |
  { readonly kind: 'closed'; readonly chatId: number } |
  { readonly kind: 'meta'; readonly chat: CoreChatMeta } |
  {
    readonly kind: 'splice';
    readonly chatId: number;
    readonly revision: number;
    readonly index: number;
    readonly remove: number;
    readonly entries: readonly CoreChatEntry[];
  } |
  {
    readonly kind: 'delta';
    readonly chatId: number;
    readonly revision: number;
    readonly index: number;
    readonly content?: string;
    readonly reasoning?: string;
  };

/** The connection picks of one send: the provider, the model, and the system prompt the page menu
 * holds while the chat sent nothing. The chat binds them on that first send. */
export interface CoreChatPicks {
  readonly providerId?: string;
  readonly model?: string;
  /** The system prompt sources the menu holds, in concatenation order. An empty list binds the none prompt. */
  readonly systemPromptIds?: readonly string[];
}

/** One provider account as a surface lists it for a first send. No key and no address ride along. */
export interface CoreConnectionAccount {
  readonly id: string;
  readonly label: string;
  /** The models of the account, each with its display label. */
  readonly models: readonly { readonly id: string; readonly label: string }[];
}

/** The connection menu of a workspace: the accounts a first send picks from, and the defaults. */
export interface CoreConnectionMenu {
  readonly accounts: readonly CoreConnectionAccount[];
  /** The account the chats use by default, or null when none is chosen. */
  readonly defaultProviderId: string | null;
  /** The model the chats use by default, or null when none is chosen. */
  readonly defaultModel: string | null;
}

/** The `chat.send` call. */
export interface CoreChatSend extends CoreChatPicks {
  readonly chatId: number;
  readonly text: string;
  readonly images: readonly ChatImageShape[];
}

/** The `chat.edit` call. A missing index marks the draft of a fork, which appends as a new message.
 * A missing image list keeps the images of the edited message. */
export interface CoreChatEdit extends CoreChatPicks {
  readonly chatId: number;
  readonly index?: number;
  readonly text: string;
  readonly images?: readonly ChatImageShape[];
}

/** The states of one patch proposal. */
export const CORE_PATCH_STATES = ['pending', 'applied', 'conflicted', 'denied', 'dismissed'] as const;

/** One patch proposal as it crosses the core, the wire shape of the patch store record. */
export interface CorePatchRecord {
  readonly id: number;
  /** The absolute path of the file the patch changes. */
  readonly path: string;
  /** The chat whose agent proposed the patch. A runtime id: it changes across restores. */
  readonly chatId: number;
  /** The session file id of the chat that proposed the patch. It survives restores, so the
   * rolling record and the read overlay keep their chat across a restart. Null on old records. */
  readonly sessionFileId: string | null;
  /** The task the patch belongs to, or null when the agent named no task. */
  readonly taskId: number | null;
  /** The unified diff text. */
  readonly patch: string;
  readonly state: (typeof CORE_PATCH_STATES)[number];
  /** The comment of a return or a denied review, when the user wrote one. */
  readonly comment: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/** One task record that groups the patch proposals of one chat, the wire shape of the patch store task. */
export interface CorePatchTask {
  readonly id: number;
  readonly chatId: number;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  /** Set when the task closed: by a new task, or by the approve choice of the user. */
  readonly closedAt: string | null;
}

/** One notice the patch store holds for the agent of one chat: a denial or a return with its comment. */
export interface CorePatchNotice {
  readonly chatId: number;
  readonly text: string;
}

/** The full patch state of the core: the patch proposals and their grouping tasks. */
export interface CorePatchState {
  readonly patches: readonly CorePatchRecord[];
  readonly tasks: readonly CorePatchTask[];
}

/** Reads the patch states that still wait for the user. */
export function patchWaitsForReview(state: CorePatchRecord['state']): boolean {
  return state === 'pending' || state === 'conflicted';
}

/** Counts the line additions and removals of one patch text. */
export function patchCounts(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1;
    }
  }
  return { added, removed };
}

/** The input of one task create call. An absent cap means none. */
export interface CoreTaskCreateInput {
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly origin: 'user' | 'agent';
  readonly originChatId: number | null;
  readonly parentTaskId: string | null;
  readonly blockedBy: readonly string[];
  /** The group of the record. An empty string means none. */
  readonly category?: string;
  readonly maxTokens?: number | null;
  readonly maxTurns?: number | null;
  readonly timeoutMs?: number | null;
  /** How many times the session retries a failed round on the same connection. */
  readonly retries?: number | null;
  /** The connections the session tries in order when its own fails. */
  readonly fallbacks?: readonly TaskConnection[];
  /** The place of the record in the queue, from 0 to the maximum. Absent means the default. */
  readonly priority?: number;
  /** The steps of the plan of the record, in order. Each starts pending. */
  readonly plan?: readonly string[];
  /** The checklist of the record: the goals a proof must meet. */
  readonly goals?: readonly string[];
}

/** The editable fields of one task record. The status is the hand override of the user edit: it
 * accepts every status and settles or revives the record fields, outside the transition table. An
 * absent cap keeps its stored value, and null clears it. */
export interface CoreTaskUpdateInput {
  readonly title?: string;
  readonly description?: string;
  readonly goal?: string;
  readonly status?: TaskStatus;
  readonly maxTokens?: number | null;
  readonly maxTurns?: number | null;
  readonly timeoutMs?: number | null;
  readonly priority?: number;
  /** The checklist of the record. A goal whose text stays the same keeps its proof. */
  readonly goals?: readonly string[];
  /** The group of the record. An empty string clears it. */
  readonly category?: string;
}

/** The full task state of the core: every dispatchable record, the archived records, and the task
 * templates. The archived records and the templates ride along as optional fields, so an older
 * core that sends none still reads. */
export interface CoreTaskState {
  readonly records: readonly TaskRecord[];
  readonly archived?: readonly TaskRecord[];
  readonly templates?: readonly TaskTemplate[];
}

/**
 * Reads one `settings.get` or `settings.delete` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The key, or null on an invalid shape.
 */
export function readSettingsKeyPayload(value: unknown): { readonly key: string } | null {
  if (!isRecord(value) || typeof value.key !== 'string') {
    return null;
  }
  return { key: value.key };
}

/**
 * Reads one `settings.set` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The key and value, or null on an invalid shape.
 */
export function readSettingsSetPayload(value: unknown): { readonly key: string; readonly value: string } | null {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.value !== 'string') {
    return null;
  }
  return { key: value.key, value: value.value };
}

/**
 * Reads one `permission.resolve` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The resolve answer, or null on an invalid shape.
 */
export function readPermissionResolvePayload(value: unknown): CorePermissionResolve | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isInteger(value.id) ||
    typeof value.approve !== 'boolean' ||
    typeof value.remember !== 'boolean'
  ) {
    return null;
  }
  return { id: value.id, approve: value.approve, remember: value.remember };
}

/**
 * Reads one `chat.sessions.save` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The session, or null on an invalid shape.
 */
export function readChatSessionPayload(value: unknown): CoreChatSession | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  return value as unknown as CoreChatSession;
}

/** Reads the images of one send or edit call. A missing list reads as none. Null on a malformed one. */
function readChatImages(value: unknown): readonly ChatImageShape[] | null {
  // Any falsy value reads as no image, the same reading the send form holds.
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const images: ChatImageShape[] = [];
  for (const image of value) {
    if (!isRecord(image) || typeof image.data !== 'string' || typeof image.mimeType !== 'string') {
      return null;
    }
    images.push({ data: image.data, mimeType: image.mimeType });
  }
  return images;
}

/** Reads the connection picks of one send or edit call. A missing pick leaves the default. */
function readChatPicks(value: Record<string, unknown>): CoreChatPicks {
  const providerId = typeof value.providerId === 'string' ? value.providerId : undefined;
  const model = typeof value.model === 'string' ? value.model : undefined;
  // An empty list is the none pick. A list that holds no string, or a value of another shape, stays out.
  const systemPromptIds = readSystemPromptIds(value.systemPromptIds);
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(systemPromptIds ? { systemPromptIds } : {}),
  };
}

/**
 * Reads one `chat.create` payload. A missing payload opens a plain chat.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The task id the new chat waits for, an empty object for a plain chat, or null when the
 * task id has another shape than a string.
 */
export function readChatCreatePayload(value: unknown): { readonly taskId?: string } | null {
  // Any falsy payload, a missing one included, opens a plain chat.
  if (!value) {
    return {};
  }
  if (!isRecord(value)) {
    return null;
  }
  // Any falsy task id names no task, so only a string names one.
  if (!value.taskId) {
    return {};
  }
  return typeof value.taskId === 'string' ? { taskId: value.taskId } : null;
}

/**
 * Reads one `chat.send` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The send, or null on an invalid shape.
 */
export function readChatSendPayload(value: unknown): CoreChatSend | null {
  if (
    !isRecord(value) ||
    typeof value.chatId !== 'number' ||
    !Number.isInteger(value.chatId) ||
    typeof value.text !== 'string'
  ) {
    return null;
  }
  const images = readChatImages(value.images);
  if (!images) {
    return null;
  }
  return { ...readChatPicks(value), chatId: value.chatId, text: value.text, images };
}

/**
 * Reads one `chat.edit` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The edit, or null on an invalid shape.
 */
export function readChatEditPayload(value: unknown): CoreChatEdit | null {
  if (
    !isRecord(value) ||
    typeof value.chatId !== 'number' ||
    !Number.isInteger(value.chatId) ||
    typeof value.text !== 'string'
  ) {
    return null;
  }
  // A missing index marks a fork draft, so only a present index needs the integer shape.
  const indexValid = value.index === undefined || (typeof value.index === 'number' && Number.isInteger(value.index));
  if (!indexValid) {
    return null;
  }
  // A missing image list keeps the images of the edited message, so the call carries none.
  const images = value.images ? readChatImages(value.images) : [];
  if (!images) {
    return null;
  }
  return {
    ...readChatPicks(value),
    chatId: value.chatId,
    ...(typeof value.index === 'number' ? { index: value.index } : {}),
    text: value.text,
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Reads one `{ chatId }` payload with a number id, the shape of the chat close, stop, and get calls.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The chat id, or null on an invalid shape.
 */
export function readChatIdPayload(value: unknown): { readonly chatId: number } | null {
  if (!isRecord(value) || typeof value.chatId !== 'number' || !Number.isInteger(value.chatId)) {
    return null;
  }
  return { chatId: value.chatId };
}

/**
 * Reads one `{ chatId, index }` payload, the shape of the retry, fork, and send-now calls.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The chat id and the entry index, or null on an invalid shape.
 */
export function readChatIndexPayload(value: unknown): { readonly chatId: number; readonly index: number } | null {
  if (
    !isRecord(value) ||
    typeof value.chatId !== 'number' ||
    !Number.isInteger(value.chatId) ||
    typeof value.index !== 'number' ||
    !Number.isInteger(value.index) ||
    value.index < 0
  ) {
    return null;
  }
  return { chatId: value.chatId, index: value.index };
}

/**
 * Reads one `chat.thinking` payload. A missing level clears the pinned effort of the chat.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The chat id and the level, or null on an invalid shape.
 */
export function readChatThinkingPayload(
  value: unknown,
): { readonly chatId: number; readonly level: CoreThinkingLevel | null } | null {
  const base = readChatIdPayload(value);
  if (!base || !isRecord(value)) {
    return null;
  }
  const level = value.level;
  // A missing level clears the pin, so only a present level needs one of the three values.
  const levelValid = level === undefined || level === null || level === 'low' || level === 'medium' || level === 'high';
  if (!levelValid) {
    return null;
  }
  return {
    chatId: base.chatId,
    level: level === 'low' || level === 'medium' || level === 'high' ? level : null,
  };
}

/** The chat id of one notify or notice call: the chat the text lands in, or null for the newest chat. */
export interface CoreChatTextCall {
  readonly chatId: number | null;
  readonly text: string;
}

/**
 * Reads one `chat.notify` or `chat.notice` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The chat id the text lands in (null for the newest chat) and the text, or null on an invalid shape.
 */
export function readChatNotifyPayload(value: unknown): CoreChatTextCall | null {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return null;
  }
  return { chatId: typeof value.chatId === 'number' ? value.chatId : null, text: value.text };
}

/**
 * Reads one call the worker sends to the main process.
 * The call crosses a process boundary, so the main process validates it before use.
 *
 * @param value The value to check. It can have any type.
 * @returns The call, or null on an invalid shape or a channel outside the list.
 */
export function readMainCall(value: unknown): CoreMainCall | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isInteger(value.id) ||
    typeof value.channel !== 'string' ||
    !MAIN_CALL_CHANNELS.includes(value.channel as (typeof MAIN_CALL_CHANNELS)[number])
  ) {
    return null;
  }
  return { id: value.id, channel: value.channel as (typeof MAIN_CALL_CHANNELS)[number], payload: value.payload };
}

/**
 * Reads one `chat.list` answer.
 *
 * @param value The reply of the core. It can have any type.
 * @returns The chat list, or null on an invalid shape.
 */
export function readChatState(value: unknown): CoreChatState | null {
  if (!isRecord(value) || !Array.isArray(value.chats)) {
    return null;
  }
  return { chats: value.chats as CoreChat[] };
}

/**
 * Reads one chat event the core pushed. Returns null on an invalid shape.
 *
 * @param value The payload of the `chat.event` push. It can have any type.
 * @returns The event, or null when a surface cannot apply it.
 */
export function readChatEvent(value: unknown): CoreChatEvent | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  const chat = isRecord(value.chat) ? value.chat : null;
  const wholeChat = Boolean(chat) && typeof chat?.id === 'number' && typeof chat?.revision === 'number';
  switch (value.kind) {
    case 'chat':
      return wholeChat ? { kind: 'chat', chat: chat as unknown as CoreChat } : null;
    case 'closed':
      return typeof value.chatId === 'number' ? { kind: 'closed', chatId: value.chatId } : null;
    case 'meta':
      return wholeChat ? { kind: 'meta', chat: chat as unknown as CoreChatMeta } : null;
    case 'splice': {
      const { chatId, revision, index, remove, entries } = value;
      if (
        typeof chatId !== 'number' ||
        typeof revision !== 'number' ||
        typeof index !== 'number' ||
        typeof remove !== 'number' ||
        !Array.isArray(entries)
      ) {
        return null;
      }
      return {
        kind: 'splice',
        chatId,
        revision,
        index,
        remove,
        entries: entries as CoreChatEntry[],
      };
    }
    case 'delta': {
      const { chatId, revision, index } = value;
      if (typeof chatId !== 'number' || typeof revision !== 'number' || typeof index !== 'number') {
        return null;
      }
      return {
        kind: 'delta',
        chatId,
        revision,
        index,
        ...(typeof value.content === 'string' ? { content: value.content } : {}),
        ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Reads one `patch.propose` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The propose call, or null on an invalid shape.
 */
export function readPatchProposePayload(
  value: unknown,
): {
  readonly chatId: number;
  readonly sessionFileId: string | null;
  readonly path: string;
  readonly oldText: string;
  readonly proposedText: string;
} | null {
  if (
    !isRecord(value) ||
    typeof value.chatId !== 'number' ||
    typeof value.path !== 'string' ||
    typeof value.oldText !== 'string' ||
    typeof value.proposedText !== 'string'
  ) {
    return null;
  }
  const sessionFileId =
    typeof value.sessionFileId === 'string' && value.sessionFileId.length > 0 ? value.sessionFileId : null;
  return {
    chatId: value.chatId,
    sessionFileId,
    path: value.path,
    oldText: value.oldText,
    proposedText: value.proposedText,
  };
}

/**
 * Reads one `{ id }` payload with a number id, the shape of most patch calls.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The id, or null on an invalid shape.
 */
export function readIdPayload(value: unknown): { readonly id: number } | null {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isInteger(value.id)) {
    return null;
  }
  return { id: value.id };
}

/**
 * Reads one `patch.deny` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The deny call, or null on an invalid shape.
 */
export function readPatchDenyPayload(value: unknown): { readonly id: number; readonly comment: string | null } | null {
  const base = readIdPayload(value);
  if (!base) {
    return null;
  }
  const comment = isRecord(value) && typeof value.comment === 'string' ? value.comment : null;
  return { id: base.id, comment };
}

/**
 * Reads one `patch.task.set` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The task set call, or null on an invalid shape.
 */
export function readPatchTaskSetPayload(
  value: unknown,
): {
  readonly chatId: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly amend: boolean;
} | null {
  if (!isRecord(value) || typeof value.chatId !== 'number' || typeof value.amend !== 'boolean') {
    return null;
  }
  const title = typeof value.title === 'string' ? value.title : null;
  const description = typeof value.description === 'string' ? value.description : null;
  return { chatId: value.chatId, title, description, amend: value.amend };
}

/** Reads one cap of a task payload: a whole number above zero, or null when the payload names none. */
function readTaskCap(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Reads the fallback chain of a task payload: the connections that name a provider and a model, in
 * order. Null when the payload holds no list. */
function readTaskConnections(value: unknown): TaskConnection[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const connections: TaskConnection[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const { providerId, model } = item as Record<string, unknown>;
    if (typeof providerId === 'string' && providerId && typeof model === 'string' && model) {
      connections.push({ providerId, model });
    }
  }
  return connections;
}

/** Reads the plan or the checklist of a task payload: the texts, in order. A payload without a list
 * names none, and an item that is no text drops out. */
function readTaskPlan(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((text): text is string => typeof text === 'string' && text.length > 0) : [];
}

/** The caps one task update payload names. A cap the payload leaves out stays out of the result, so
 * the store keeps its stored value. */
function readTaskCaps(input: Record<string, unknown>): Pick<CoreTaskUpdateInput, 'maxTokens' | 'maxTurns' | 'timeoutMs'> {
  const caps: { maxTokens?: number | null; maxTurns?: number | null; timeoutMs?: number | null } = {};
  for (const key of ['maxTokens', 'maxTurns', 'timeoutMs'] as const) {
    if (Object.hasOwn(input, key)) {
      caps[key] = readTaskCap(input[key]);
    }
  }
  return caps;
}

/**
 * Reads one `task.create` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The create input, or null on an invalid shape.
 */
export function readTaskCreatePayload(value: unknown): CoreTaskCreateInput | null {
  if (
    !isRecord(value) ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.goal !== 'string' ||
    (value.origin !== 'user' && value.origin !== 'agent') ||
    !Array.isArray(value.blockedBy) ||
    !value.blockedBy.every((id): id is string => typeof id === 'string')
  ) {
    return null;
  }
  const parentTaskId = typeof value.parentTaskId === 'string' ? value.parentTaskId : null;
  const originChatId = typeof value.originChatId === 'number' ? value.originChatId : null;
  return {
    title: value.title,
    description: value.description,
    goal: value.goal,
    origin: value.origin,
    originChatId,
    parentTaskId,
    blockedBy: value.blockedBy,
    maxTokens: readTaskCap(value.maxTokens),
    maxTurns: readTaskCap(value.maxTurns),
    timeoutMs: readTaskCap(value.timeoutMs),
    retries: typeof value.retries === 'number' && Number.isFinite(value.retries) && value.retries >= 0 ? Math.floor(value.retries) : null,
    fallbacks: readTaskConnections(value.fallbacks) ?? [],
    priority: readTaskPriority(value.priority),
    plan: readTaskPlan(value.plan),
    goals: readTaskPlan(value.goals),
    category: typeof value.category === 'string' ? value.category : '',
  };
}

/**
 * Reads one `task.dispatch` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The dispatch call, or null on an invalid shape.
 */
export function readTaskDispatchPayload(
  value: unknown,
): { readonly id: string; readonly mode: 'new-session' | 'session'; readonly sessionFileId: string | null } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.mode !== 'new-session' && value.mode !== 'session')) {
    return null;
  }
  const sessionFileId = typeof value.sessionFileId === 'string' ? value.sessionFileId : null;
  return { id: value.id, mode: value.mode, sessionFileId };
}

/**
 * Reads one `task.bind` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The bind call, or null on an invalid shape.
 */
export function readTaskBindPayload(
  value: unknown,
): { readonly id: string; readonly chatId: number; readonly sessionFileId: string } | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.chatId !== 'number' ||
    typeof value.sessionFileId !== 'string'
  ) {
    return null;
  }
  return { id: value.id, chatId: value.chatId, sessionFileId: value.sessionFileId };
}

/**
 * Reads one `task.complete` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The complete call, or null on an invalid shape.
 */
export function readTaskCompletePayload(
  value: unknown,
): { readonly id: string; readonly result: string; readonly evidence: string | null } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.result !== 'string') {
    return null;
  }
  const evidence = typeof value.evidence === 'string' ? value.evidence : null;
  return { id: value.id, result: value.result, evidence };
}

/**
 * Reads one `task.fail` or `task.cancel` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The call with its note, or null on an invalid shape.
 */
export function readTaskNotePayload(value: unknown): { readonly id: string; readonly note: string | null } | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  const note = typeof value.note === 'string' ? value.note : null;
  return { id: value.id, note };
}

/**
 * Reads one `task.relink` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The relink call, or null on an invalid shape.
 */
export function readTaskRelinkPayload(value: unknown): { readonly id: string; readonly chatId: number } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.chatId !== 'number') {
    return null;
  }
  return { id: value.id, chatId: value.chatId };
}

/**
 * Reads one `task.answer` payload: the answer of the operator to the question of a blocked task.
 *
 * @param value The value to check. It can have any type.
 * @returns The call, or null on an invalid shape.
 */
export function readTaskAnswerPayload(value: unknown): { readonly id: string; readonly answer: string } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.answer !== 'string' || value.answer.length === 0) {
    return null;
  }
  return { id: value.id, answer: value.answer };
}

/**
 * Reads one `task.update` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The update call, or null on an invalid shape.
 */
export function readTaskUpdatePayload(
  value: unknown,
): { readonly id: string; readonly input: CoreTaskUpdateInput } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.input)) {
    return null;
  }
  const input = value.input;
  const title = typeof input.title === 'string' && input.title ? input.title : undefined;
  const description = typeof input.description === 'string' ? input.description : undefined;
  const goal = typeof input.goal === 'string' ? input.goal : undefined;
  const status = isTaskStatus(input.status) ? input.status : undefined;
  // A priority the payload names is read and capped. One it leaves out, or one that arrives in
  // another shape, keeps the stored value.
  const priority = typeof input.priority === 'number' ? readTaskPriority(input.priority) : undefined;
  // A checklist that arrives as no list names no change: only a list replaces the stored one.
  const goals = Array.isArray(input.goals) ? readTaskPlan(input.goals) : undefined;
  const changes: CoreTaskUpdateInput = {
    ...(title ? { title } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof goal === 'string' ? { goal } : {}),
    ...(status ? { status } : {}),
    ...(typeof priority === 'number' ? { priority } : {}),
    ...(goals ? { goals } : {}),
    ...(typeof input.category === 'string' ? { category: input.category } : {}),
    ...readTaskCaps(input),
  };
  return { id: value.id, input: changes };
}

/**
 * Reads one `task.next` payload.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The session file id, or null on an invalid shape.
 */
export function readTaskNextPayload(value: unknown): { readonly sessionFileId: string } | null {
  if (!isRecord(value) || typeof value.sessionFileId !== 'string') {
    return null;
  }
  return { sessionFileId: value.sessionFileId };
}

/**
 * Reads one `{ id }` payload with a string id, the shape of most task calls.
 *
 * @param value The payload of the request. It can have any type.
 * @returns The id, or null on an invalid shape.
 */
export function readTaskStringIdPayload(value: unknown): { readonly id: string } | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  return { id: value.id };
}

/** The list answers of the core: typed aliases over the shared record shapes. */
export type CorePatchListReply = readonly CorePatchRecord[];
export type CoreTaskListReply = readonly TaskRecord[];
export type { BridgePermissionCheck, TaskRecord };
