/**
 * The contract of the background core: the worker process that owns the app state, and the
 * channels every surface speaks with it. The framing is transport free: the renderer rides the
 * core slice of the bridge through the main process, and the remote control page rides HTTP with
 * its event stream. A channel enters the contract together with the worker case that serves it.
 */

import { isRecord } from './records.js';
import type { BridgePermissionCheck, ChatImageShape } from './bridge.js';
import { isPermissionRule, type PermissionRule } from './permissions.js';
import { isTaskStatus, type TaskRecord, type TaskStatus } from './tasks.js';

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
  'task.reopen',
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
  /** The storage setup id of the workspace marker. */
  readonly storageId: string;
  /** The non-secret storage configuration of the workspace marker. */
  readonly storageConfig: unknown;
  /** The workspace password, or null when the setup needs none. */
  readonly password: string | null;
  /** The absolute path of the app root, for the static assets the remote server serves. */
  readonly appRoot: string;
}

/** What the main process sends to the worker. */
export type MainToWorkerMessage =
  | { readonly kind: 'start'; readonly start: WorkerStart } |
  { readonly kind: 'request'; readonly request: CoreRequest } |
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

/** What the worker sends to the main process. */
export type WorkerToMainMessage =
  | { readonly kind: 'ready' } |
  { readonly kind: 'failed'; readonly message: string } |
  { readonly kind: 'reply'; readonly reply: CoreReply } |
  { readonly kind: 'event'; readonly event: CoreEvent } |
  { readonly kind: 'log'; readonly record: WorkerLogRecord } |
  { readonly kind: 'chatSend'; readonly send: { readonly fileId: string | null; readonly text: string } };

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
    storageId: value.storageId,
    storageConfig: value.storageConfig,
    password,
    appRoot,
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
  readonly systemPrompt?: { readonly sourceId: string; readonly title: string; readonly text: string };
  readonly thinkingLevel?: 'low' | 'medium' | 'high';
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

/** The input of one task create call. */
export interface CoreTaskCreateInput {
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly origin: 'user' | 'agent';
  readonly originChatId: number | null;
  readonly parentTaskId: string | null;
  readonly blockedBy: readonly string[];
}

/** The editable fields of one task record. The status is the hand override of the user edit: it
 * accepts every status and settles or revives the record fields, outside the transition table. */
export interface CoreTaskUpdateInput {
  readonly title?: string;
  readonly description?: string;
  readonly goal?: string;
  readonly status?: TaskStatus;
}

/** The full task state of the core: every dispatchable record. */
export interface CoreTaskState {
  readonly records: readonly TaskRecord[];
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
  const changes: CoreTaskUpdateInput = {
    ...(title ? { title } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof goal === 'string' ? { goal } : {}),
    ...(status ? { status } : {}),
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
