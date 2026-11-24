/**
 * The background core of the app: one utility process that owns the workspace storage, the
 * permission gate, the patch and task stores, the chat session files, the chat engine, and the
 * remote control server. The main process forks this module for every workspace window and speaks
 * the core contract over the parent port (`src/shared/core-api.ts`). The services that stayed in
 * the main process — the window and command tools, the MCP client — answer the calls the engine
 * sends back over the same port.
 */

import { join } from 'node:path';
import { bindRecordForwarder, log } from './logger.js';
import { JsonFileStorage } from '../storage/json-file.js';
import { readEncryptionSuite, type EncryptionSuiteId } from '../storage/encryption.js';
import type { StorageBackend } from '../storage/storage.js';
import { WorkspaceSettingsStore, SHARED_STORAGES_KEY } from '../storage/settings-store.js';
import { StorageShareRegistry, type SharedStorageSetupSource } from '../storage/share-registry.js';
import { OpenAiInferenceProvider } from '../providers/openai.js';
import { setHarnessDocLoader } from '../shared/harness-docs.js';
import { nodeJsonFileFs } from './node-fs.js';
import { WorkerPermissionGate } from './permission-gate.js';
import { PatchStore } from './patch-store.js';
import { TaskStore } from './task-store.js';
import { ChatSessionStore } from './chat-sessions.js';
import { ChatEngine, type EngineMainCalls } from './chat-engine.js';
import { workerSystemPromptSources } from './system-prompts.js';
import { readTextFile } from './node-file-system.js';
import { RemoteServer } from './remote-server.js';
import type { RemoteServerConfig } from '../storage/settings-store.js';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';
import type { PermissionTarget, PrincipalKind } from '../shared/permissions.js';
import type { CoreMainCall } from '../shared/core-api.js';
import { isRecord } from '../shared/records.js';
import type { McpCallResult, McpNativeTool } from '../shared/mcp-endpoints.js';
import type { McpToolResult } from '../shared/window-tools.js';
import {
  readChatEditPayload,
  readChatIdPayload,
  readChatIndexPayload,
  readChatNotifyPayload,
  readChatSendPayload,
  readChatThinkingPayload,
  readIdPayload,
  readPatchDenyPayload,
  readPatchProposePayload,
  readPatchTaskSetPayload,
  readPermissionCheckPayload,
  readPermissionResolvePayload,
  readPermissionRulePayload,
  readChatSessionPayload,
  readSettingsKeyPayload,
  readSettingsSetPayload,
  readTaskBindPayload,
  readTaskCompletePayload,
  readTaskCreatePayload,
  readTaskDispatchPayload,
  readTaskNextPayload,
  readTaskNotePayload,
  readTaskRelinkPayload,
  readTaskStringIdPayload,
  readTaskUpdatePayload,
  readWorkerStart,
  WORKER_STORAGE_IDS,
  type CoreChatState,
  type CorePatchState,
  type CorePermissionState,
  type CoreTaskState,
  type MainToWorkerMessage,
  type WorkerStart,
  type WorkerToMainMessage,
} from '../shared/core-api.js';
import { workspaceSettingsFilePath } from '../shared/workspace.js';

/** The parent port of the utility process, declared here so the worker stays free of electron imports. */
interface ParentPort {
  on(event: 'message', listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const openedPort = (process as { parentPort?: ParentPort }).parentPort;
if (!openedPort) {
  throw new Error('The worker core needs the parent port of a utility process.');
}
const port: ParentPort = openedPort;

/** The id the settings storage carries for the chat agent. The workspace page reaches the same
 * storage through the core slice under this id, so the settings pane shows it and a shared
 * settings storage reads as `storage://core/<key>`. */
const SETTINGS_STORAGE_ID = 'core';

/** The opened storage of the workspace. Null until the start message opened it. */
let storage: StorageBackend | null = null;

/** The permission gate over the opened storage. Null until the start message opened it. */
let gate: WorkerPermissionGate | null = null;

/** The patch store of the workspace. Null until the start message opened the storage. */
let patches: PatchStore | null = null;

/** The task store of the workspace. Null until the start message opened the storage. */
let tasks: TaskStore | null = null;

/** The chat session store of the workspace. Null until the start message opened the storage. */
let chatSessions: ChatSessionStore | null = null;

/** The chat engine of the workspace. Null until the start message opened the storage. */
let engine: ChatEngine | null = null;

/** The settings store and the storage sharing registry the engine reads. Null until the start message opened the storage. */
let settingsStore: WorkspaceSettingsStore | null = null;
let storageShares: StorageShareRegistry | null = null;

/** The remote control server of the workspace. Null until the start message opened the storage. */
let remote: RemoteServer | null = null;

/** The calls the worker waits an answer for from the main process, keyed by call id. */
const mainCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

/** The id of the next call to the main process. */
let nextMainCallId = 1;

/**
 * Calls one service of the main process and waits for its answer.
 * The services that stayed in main — the window and command tools, the MCP client — answer through
 * the parent port. A window tool may wait for a permission card, so the call carries no timeout.
 *
 * @param channel One channel of the call contract, `CoreMainCall['channel']`.
 * @param payload The payload of the call.
 * @returns The answer of the main process.
 * @throws Error when the main process reports a failure.
 */
function callMain(channel: CoreMainCall['channel'], payload: unknown): Promise<unknown> {
  const id = nextMainCallId;
  nextMainCallId += 1;
  return new Promise((resolve, reject) => {
    mainCalls.set(id, { resolve, reject });
    send({ kind: 'call', call: { id, channel, payload } });
  });
}

/** The services of the main process as the chat engine reaches them. */
const mainCallsSurface: EngineMainCalls = {
  runWindowTool: (name, args, source) => callMain('windowTool', { name, args, source }) as Promise<McpToolResult>,
  readResource: (uri) => callMain('mcp.readResource', { uri }) as Promise<string>,
  nativeTools: () => callMain('mcp.nativeTools', null) as Promise<readonly McpNativeTool[]>,
  runNativeTool: (name, args) => callMain('mcp.runNativeTool', { name, args }) as Promise<McpCallResult>,
};

/** Sends the permission state of the gate to every surface. */
function emitPermissionState(): void {
  if (!gate) {
    return;
  }
  const state: CorePermissionState = { pending: gate.pendingRequests(), rules: gate.listRules() };
  send({ kind: 'event', event: { channel: 'permission.event', payload: state } });
  remote?.broadcast('permission', state);
}

/** Sends the patch state to every surface. */
function emitPatchState(): void {
  if (!patches) {
    return;
  }
  const state: CorePatchState = { patches: patches.listPatches(), tasks: patches.listTasks() };
  send({ kind: 'event', event: { channel: 'patch.event', payload: state } });
  remote?.broadcast('patches', state);
}

/** Sends the task state to every surface. */
function emitTaskState(): void {
  if (!tasks) {
    return;
  }
  const state: CoreTaskState = { records: tasks.list() };
  send({ kind: 'event', event: { channel: 'task.event', payload: state } });
  remote?.broadcast('tasks', state);
}

/** Sends one message to the main process. */
function send(message: WorkerToMainMessage): void {
  port.postMessage(message);
}

/** Replies one request with a value. */
function replyValue(id: number, value: unknown): void {
  send({ kind: 'reply', reply: { id, ok: true, value } });
}

/** Replies one request with an error. */
function replyError(id: number, message: string): void {
  send({ kind: 'reply', reply: { id, ok: false, error: message } });
}

/** Reads the encryption suite out of one storage configuration. Returns undefined without one. */
function suiteFromConfig(config: unknown): EncryptionSuiteId | undefined {
  if (typeof config !== 'object' || !config) {
    return undefined;
  }
  const suite = (config as Record<string, unknown>).suite;
  return typeof suite === 'string' ? readEncryptionSuite(suite) : undefined;
}

/** Reads one storage setup a shared storage opens through: the built-in JSON setups, over the fs of
 * the worker. A plugin setup cannot open here; the undefined answer makes the share report it. */
function sharedStorageSetup(setupId: string): SharedStorageSetupSource | undefined {
  if (setupId === 'json') {
    return {
      open: ({ directoryPath }) =>
        new JsonFileStorage({ path: workspaceSettingsFilePath(directoryPath), fs: nodeJsonFileFs }),
    };
  }
  if (setupId === 'json-password') {
    return {
      open: ({ directoryPath, config, password }) => {
        const suite = suiteFromConfig(config);
        return new JsonFileStorage({
          path: workspaceSettingsFilePath(directoryPath),
          fs: nodeJsonFileFs,
          password: password ?? '',
          ...(suite ? { suite } : {}),
        });
      },
    };
  }
  return undefined;
}

/** Applies the stored sharing record to the registry of the worker: every shared storage opens, and
 * a removed one leaves. Runs at boot and after a surface saves the record. */
async function refreshStorageShares(): Promise<void> {
  if (!settingsStore || !storageShares) {
    return;
  }
  storageShares.applyRecord(await settingsStore.loadSharedStorages());
}

/**
 * Opens the workspace storage and proves it readable.
 * The first keys read forces the file load, so a wrong password fails here, not on a later call.
 *
 * @param start The validated start data.
 */
async function openStorage(start: WorkerStart): Promise<void> {
  if (!WORKER_STORAGE_IDS.includes(start.storageId)) {
    throw new Error(`The storage "${start.storageId}" of this workspace cannot open in the worker core.`);
  }
  const suite = suiteFromConfig(start.storageConfig);
  const backend = new JsonFileStorage({
    id: SETTINGS_STORAGE_ID,
    path: workspaceSettingsFilePath(start.directoryPath),
    fs: nodeJsonFileFs,
    ...(start.password ? { password: start.password } : {}),
    ...(suite ? { suite } : {}),
  });
  await backend.keys();
  storage = backend;
  gate = new WorkerPermissionGate(new WorkspaceSettingsStore(backend), emitPermissionState);
  patches = new PatchStore(start.directoryPath);
  await patches.load();
  patches.subscribe(emitPatchState);
  patches.onNotice((notice) => {
    send({ kind: 'event', event: { channel: 'patch.notice', payload: notice } });
  });
  tasks = new TaskStore(start.directoryPath);
  await tasks.load();
  tasks.subscribe(emitTaskState);
  tasks.onSettle((task) => {
    send({ kind: 'event', event: { channel: 'task.settle', payload: task } });
  });
  // A password-protected setup seals the session files, and the chat key rides the settings store.
  chatSessions = new ChatSessionStore(
    start.directoryPath,
    new WorkspaceSettingsStore(backend),
    start.storageId === 'json-password',
  );
  await chatSessions.init();
  // The harness documents ship with the renderer build. The worker holds no page origin to fetch
  // them from, so the read tool and the system prompt source read them from disk.
  const docsRoot = join(start.appRoot, 'dist', 'renderer');
  setHarnessDocLoader(async (file) => {
    const text = await readTextFile(join(docsRoot, file));
    // eslint-disable-next-line local/prefer-truthiness -- an empty document is present, only a failed read counts as absent
    if (text === null) {
      throw new Error(`The harness document ${file} is not on disk under ${docsRoot}.`);
    }
    return text;
  });
  settingsStore = new WorkspaceSettingsStore(backend);
  storageShares = new StorageShareRegistry(
    backend,
    (setupId) => sharedStorageSetup(setupId),
    start.directoryPath,
    () => gate?.listRules() ?? [],
  );
  await refreshStorageShares();
  // The chat engine owns the chats: the restored sessions, the turns, and the task sessions. The
  // services that stayed in main answer its calls over the parent port.
  engine = new ChatEngine({
    workspacePath: start.directoryPath,
    gate,
    patches,
    tasks,
    chatSessions,
    settings: settingsStore,
    storageShares,
    promptSources: workerSystemPromptSources(),
    main: mainCallsSurface,
    createProvider: OpenAiInferenceProvider,
    emit: (event) => {
      send({ kind: 'event', event });
    },
  });
  await engine.restore();
  // Denials and returns leave for the agent of their chat. Every record change pumps the queue,
  // and a settle reaches the origin chat that did not cause it.
  patches.onNotice((notice) => {
    engine?.deliverPatchNotice(notice);
  });
  tasks.subscribe(() => {
    engine?.pumpTasks();
  });
  tasks.onSettle((task) => {
    engine?.deliverTaskSettle(task);
  });
  const settingsForRemote = new WorkspaceSettingsStore(backend);
  remote = new RemoteServer(
    settingsForRemote,
    start.directoryPath,
    start.appRoot,
    {
      permission: () =>
        gate ? { pending: gate.pendingRequests(), rules: gate.listRules() } : { pending: [], rules: [] },
      patches: () =>
        patches ? { patches: patches.listPatches(), tasks: patches.listTasks() } : { patches: [], tasks: [] },
      tasks: () => (tasks ? { records: tasks.list() } : { records: [] }),
      chatSessions: () => chatSessions?.loadSessions() ?? Promise.resolve([]),
      resolvePermission: (id, approve, remember) => requireGate().resolveRequest(id, approve, remember),
      applyPatch: (id) => requirePatches().apply(id),
      denyPatch: (id, comment) => requirePatches().deny(id, comment),
      dismissPatch: (id) => requirePatches().dismiss(id),
      acceptTask: (id) => requireTasks().accept(id),
      returnTask: (id) => requireTasks().returnToSession(id),
      cancelTask: (id) => requireTasks().cancel(id, null),
      // The phone sends into the chat engine of this core, the same engine the workspace page uses.
      sendChat: (fileId, text) => {
        requireEngine().remoteSend(fileId, text);
      },
    },
    async (addresses) => {
      const altNames = addresses.map((ip) => ({ type: 7 as const, ip }));
      const generated = await selfsigned.generate([{ name: 'commonName', value: 'nodewavenui-remote' }], {
        keySize: 2048,
        extensions: [{ name: 'subjectAltName', altNames }],
      });
      return { cert: generated.cert, key: generated.private };
    },
    (text) => QRCode.toDataURL(text, { margin: 1, width: 480 }),
  );
  const remoteConfig = await settingsForRemote.loadRemoteServerConfig();
  if (remoteConfig.enabled) {
    try {
      await remote.start(remoteConfig);
    } catch (error) {
      // The remote control is one optional service: a stale bind or a taken port must not
      // close the storage of the whole core. The settings section reports the failure.
      const message = error instanceof Error ? error.message : String(error);
      log.worker.warning(`the remote control could not start: ${message}`);
    }
  }
}

/** Reads the open gate, or throws its missing-state error. */
function requireGate(): WorkerPermissionGate {
  if (!gate) {
    throw new Error('The worker core holds no open storage.');
  }
  return gate;
}

/** Reads the open patch store, or throws its missing-state error. */
function requirePatches(): PatchStore {
  if (!patches) {
    throw new Error('The worker core holds no open storage.');
  }
  return patches;
}

/** Reads the open task store, or throws its missing-state error. */
function requireTasks(): TaskStore {
  if (!tasks) {
    throw new Error('The worker core holds no open storage.');
  }
  return tasks;
}

/** Reads the open chat engine, or throws its missing-state error. */
function requireEngine(): ChatEngine {
  if (!engine) {
    throw new Error('The worker core holds no open storage.');
  }
  return engine;
}

/** Handles one request message against the opened storage. */
async function serveRequest(id: number, channel: string, payload: unknown): Promise<void> {
  if (!storage) {
    replyError(id, 'The worker core holds no open storage.');
    return;
  }
  switch (channel) {
    case 'settings.get': {
      const request = readSettingsKeyPayload(payload);
      if (!request) {
        replyError(id, 'The settings.get call needs a key string.');
        return;
      }
      replyValue(id, await storage.get(request.key));
      return;
    }
    case 'settings.set': {
      const request = readSettingsSetPayload(payload);
      if (!request) {
        replyError(id, 'The settings.set call needs a key and a value string.');
        return;
      }
      await storage.set(request.key, request.value);
      // The sharing record opens the shared storages the read tool serves, so a saved record applies at once.
      if (request.key === SHARED_STORAGES_KEY) {
        await refreshStorageShares();
      }
      replyValue(id, null);
      return;
    }
    case 'settings.delete': {
      const request = readSettingsKeyPayload(payload);
      if (!request) {
        replyError(id, 'The settings.delete call needs a key string.');
        return;
      }
      await storage.delete(request.key);
      replyValue(id, null);
      return;
    }
    case 'settings.keys': {
      replyValue(id, await storage.keys());
      return;
    }
    case 'permission.check': {
      const check = readPermissionCheckPayload(payload);
      if (!check || !gate) {
        replyError(id, 'The permission.check call needs an open storage and a full check payload.');
        return;
      }
      await gate.check(
        check.principal as PrincipalKind,
        check.action,
        check.target as PermissionTarget,
        check.description,
        check.source,
        check.preauthorized,
      );
      replyValue(id, null);
      return;
    }
    case 'permission.list': {
      if (!gate) {
        replyError(id, 'The worker core holds no open storage.');
        return;
      }
      replyValue(id, { pending: gate.pendingRequests(), rules: gate.listRules() } satisfies CorePermissionState);
      return;
    }
    case 'permission.resolve': {
      const resolve = readPermissionResolvePayload(payload);
      if (!resolve || !gate) {
        replyError(id, 'The permission.resolve call needs an open storage and a full resolve payload.');
        return;
      }
      await gate.resolveRequest(resolve.id, resolve.approve, resolve.remember);
      replyValue(id, null);
      return;
    }
    case 'permission.rule.add': {
      const rule = readPermissionRulePayload(payload);
      if (!rule || !gate) {
        replyError(id, 'The permission.rule.add call needs an open storage and a valid rule.');
        return;
      }
      await gate.addRule(rule);
      replyValue(id, null);
      return;
    }
    case 'permission.rule.remove': {
      if (!gate || !isRecord(payload) || typeof payload.id !== 'string') {
        replyError(id, 'The permission.rule.remove call needs an open storage and a rule id string.');
        return;
      }
      await gate.removeRule(payload.id);
      replyValue(id, null);
      return;
    }
    case 'patch.list': {
      if (!patches) {
        replyError(id, 'The worker core holds no patch store.');
        return;
      }
      replyValue(id, { patches: patches.listPatches(), tasks: patches.listTasks() } satisfies CorePatchState);
      return;
    }
    case 'patch.propose': {
      const call = readPatchProposePayload(payload);
      if (!call || !patches) {
        replyError(id, 'The patch.propose call needs an open patch store and a full payload.');
        return;
      }
      replyValue(
        id,
        await patches.propose(call.chatId, call.sessionFileId, call.path, call.oldText, call.proposedText),
      );
      return;
    }
    case 'patch.apply': {
      const call = readIdPayload(payload);
      if (!call || !patches) {
        replyError(id, 'The patch.apply call needs an open patch store and a patch id.');
        return;
      }
      replyValue(id, await patches.apply(call.id));
      return;
    }
    case 'patch.deny': {
      const call = readPatchDenyPayload(payload);
      if (!call || !patches) {
        replyError(id, 'The patch.deny call needs an open patch store and a patch id.');
        return;
      }
      await patches.deny(call.id, call.comment);
      replyValue(id, null);
      return;
    }
    case 'patch.dismiss': {
      const call = readIdPayload(payload);
      if (!call || !patches) {
        replyError(id, 'The patch.dismiss call needs an open patch store and a patch id.');
        return;
      }
      await patches.dismiss(call.id);
      replyValue(id, null);
      return;
    }
    case 'patch.delete': {
      const call = readIdPayload(payload);
      if (!call || !patches) {
        replyError(id, 'The patch.delete call needs an open patch store and a patch id.');
        return;
      }
      await patches.deletePatch(call.id);
      replyValue(id, null);
      return;
    }
    case 'patch.clear': {
      if (!patches) {
        replyError(id, 'The worker core holds no patch store.');
        return;
      }
      await patches.clearResolved();
      replyValue(id, null);
      return;
    }
    case 'patch.task.set': {
      const call = readPatchTaskSetPayload(payload);
      if (!call || !patches) {
        replyError(id, 'The patch.task.set call needs an open patch store and a full payload.');
        return;
      }
      replyValue(id, await patches.setTask(call.chatId, call.title, call.description, call.amend));
      return;
    }
    case 'patch.task.close': {
      if (!patches || !isRecord(payload) || typeof payload.chatId !== 'number') {
        replyError(id, 'The patch.task.close call needs an open patch store and a chat id.');
        return;
      }
      await patches.closeTask(payload.chatId);
      replyValue(id, null);
      return;
    }
    case 'task.list': {
      if (!tasks) {
        replyError(id, 'The worker core holds no task store.');
        return;
      }
      replyValue(id, { records: tasks.list() } satisfies CoreTaskState);
      return;
    }
    case 'task.create': {
      const input = isRecord(payload) ? readTaskCreatePayload(payload.input) : null;
      if (!input || !tasks) {
        replyError(id, 'The task.create call needs an open task store and a full input.');
        return;
      }
      replyValue(id, await tasks.create(input));
      return;
    }
    case 'task.dispatch': {
      const call = readTaskDispatchPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.dispatch call needs an open task store and a full payload.');
        return;
      }
      replyValue(id, await tasks.dispatch(call.id, call.mode, call.sessionFileId));
      return;
    }
    case 'task.next': {
      const call = readTaskNextPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.next call needs an open task store and a session file id.');
        return;
      }
      replyValue(id, tasks.nextQueuedFor(call.sessionFileId));
      return;
    }
    case 'task.bind': {
      const call = readTaskBindPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.bind call needs an open task store and a full payload.');
        return;
      }
      replyValue(id, await tasks.bindSession(call.id, call.chatId, call.sessionFileId));
      return;
    }
    case 'task.complete': {
      const call = readTaskCompletePayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.complete call needs an open task store and a full payload.');
        return;
      }
      replyValue(id, await tasks.complete(call.id, call.result, call.evidence));
      return;
    }
    case 'task.fail':
    case 'task.cancel': {
      const call = readTaskNotePayload(payload);
      if (!call || !tasks) {
        replyError(id, `The ${channel} call needs an open task store and a task id.`);
        return;
      }
      replyValue(id, channel === 'task.fail' ? await tasks.fail(call.id, call.note) : await tasks.cancel(call.id, call.note));
      return;
    }
    case 'task.accept': {
      const call = readTaskStringIdPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.accept call needs an open task store and a task id.');
        return;
      }
      replyValue(id, await tasks.accept(call.id));
      return;
    }
    case 'task.return': {
      const call = readTaskStringIdPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.return call needs an open task store and a task id.');
        return;
      }
      replyValue(id, await tasks.returnToSession(call.id));
      return;
    }
    case 'task.reopen': {
      const call = readTaskStringIdPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.reopen call needs an open task store and a task id.');
        return;
      }
      replyValue(id, await tasks.reopen(call.id));
      return;
    }
    case 'task.relink': {
      const call = readTaskRelinkPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.relink call needs an open task store and a full payload.');
        return;
      }
      await tasks.relink(call.id, call.chatId);
      replyValue(id, null);
      return;
    }
    case 'task.update': {
      const call = readTaskUpdatePayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.update call needs an open task store and a full payload.');
        return;
      }
      replyValue(id, await tasks.update(call.id, call.input));
      return;
    }
    case 'task.remove': {
      const call = readTaskStringIdPayload(payload);
      if (!call || !tasks) {
        replyError(id, 'The task.remove call needs an open task store and a task id.');
        return;
      }
      await tasks.remove(call.id);
      replyValue(id, null);
      return;
    }
    case 'chat.sessions.load': {
      if (!chatSessions) {
        replyError(id, 'The worker core holds no chat session store.');
        return;
      }
      replyValue(id, await chatSessions.loadSessions());
      return;
    }
    case 'chat.sessions.save': {
      const session = readChatSessionPayload(payload);
      if (!session || !chatSessions) {
        replyError(id, 'The chat.sessions.save call needs an open session store and a full session.');
        return;
      }
      chatSessions.saveSession(session);
      replyValue(id, null);
      return;
    }
    case 'chat.sessions.delete': {
      if (!chatSessions || !isRecord(payload) || typeof payload.id !== 'string') {
        replyError(id, 'The chat.sessions.delete call needs an open session store and a session id.');
        return;
      }
      chatSessions.deleteSession(payload.id);
      replyValue(id, null);
      return;
    }
    case 'chat.list': {
      replyValue(id, { chats: requireEngine().list() } satisfies CoreChatState);
      return;
    }
    case 'chat.get': {
      const call = readChatIdPayload(payload);
      if (!call) {
        replyError(id, 'The chat.get call needs a chat id.');
        return;
      }
      replyValue(id, requireEngine().get(call.chatId));
      return;
    }
    case 'chat.create': {
      replyValue(id, requireEngine().create());
      return;
    }
    case 'chat.close': {
      const call = readChatIdPayload(payload);
      if (!call) {
        replyError(id, 'The chat.close call needs a chat id.');
        return;
      }
      requireEngine().close(call.chatId);
      replyValue(id, null);
      return;
    }
    case 'chat.send': {
      const call = readChatSendPayload(payload);
      if (!call) {
        replyError(id, 'The chat.send call needs a chat id, a text, and well-formed images.');
        return;
      }
      // The answer tells whether the message landed. The turn itself runs on, past the request.
      replyValue(id, await requireEngine().send(call));
      return;
    }
    case 'chat.stop': {
      const call = readChatIdPayload(payload);
      if (!call) {
        replyError(id, 'The chat.stop call needs a chat id.');
        return;
      }
      requireEngine().stop(call.chatId);
      replyValue(id, null);
      return;
    }
    case 'chat.retry': {
      const call = readChatIndexPayload(payload);
      if (!call) {
        replyError(id, 'The chat.retry call needs a chat id and an entry index.');
        return;
      }
      requireEngine().retry(call.chatId, call.index);
      replyValue(id, null);
      return;
    }
    case 'chat.fork': {
      const call = readChatIndexPayload(payload);
      if (!call) {
        replyError(id, 'The chat.fork call needs a chat id and an entry index.');
        return;
      }
      replyValue(id, requireEngine().fork(call.chatId, call.index));
      return;
    }
    case 'chat.edit': {
      const call = readChatEditPayload(payload);
      if (!call) {
        replyError(id, 'The chat.edit call needs a chat id, a text, and well-formed images.');
        return;
      }
      await requireEngine().edit(call);
      replyValue(id, null);
      return;
    }
    case 'chat.sendNow': {
      const call = readChatIndexPayload(payload);
      if (!call) {
        replyError(id, 'The chat.sendNow call needs a chat id and an entry index.');
        return;
      }
      await requireEngine().sendNow(call.chatId, call.index);
      replyValue(id, null);
      return;
    }
    case 'chat.thinking': {
      const call = readChatThinkingPayload(payload);
      if (!call) {
        replyError(id, 'The chat.thinking call needs a chat id and a known level, or none.');
        return;
      }
      requireEngine().setThinking(call.chatId, call.level);
      replyValue(id, null);
      return;
    }
    case 'chat.notify': {
      const call = readChatNotifyPayload(payload);
      if (!call) {
        replyError(id, 'The chat.notify call needs a text.');
        return;
      }
      requireEngine().notify(call.chatId, call.text);
      replyValue(id, null);
      return;
    }
    case 'chat.notice': {
      const call = readChatNotifyPayload(payload);
      if (!call) {
        replyError(id, 'The chat.notice call needs a text.');
        return;
      }
      requireEngine().notice(call.chatId, call.text);
      replyValue(id, null);
      return;
    }
    case 'chat.tools': {
      replyValue(id, await requireEngine().listTools());
      return;
    }
    case 'chat.dispatch': {
      // The task board dispatches: the turn of the session runs on its own, past the request.
      const call = readTaskDispatchPayload(payload);
      if (!call) {
        replyError(id, 'The chat.dispatch call needs a task id and a dispatch mode.');
        return;
      }
      replyValue(id, await requireEngine().dispatch(call.id, call.mode, call.sessionFileId, false));
      return;
    }
    case 'chat.task.return': {
      const call = readTaskNotePayload(payload);
      if (!call) {
        replyError(id, 'The chat.task.return call needs a task id.');
        return;
      }
      await requireEngine().returnTask(call.id, call.note);
      replyValue(id, null);
      return;
    }
    case 'remote.config.get': {
      if (!remote) {
        replyError(id, 'The worker core holds no remote server.');
        return;
      }
      replyValue(id, {
        ...(remote.currentConfig() ?? { enabled: false, port: 9777, bind: '0.0.0.0', allowPlainHttp: false }),
        origin: remote.origin(),
        interfaces: remote.bindableAddresses(),
      });
      return;
    }
    case 'remote.config.save': {
      if (!remote || !isRecord(payload)) {
        replyError(id, 'The remote.config.save call needs an open remote server and a full configuration.');
        return;
      }
      const bind = typeof payload.bind === 'string' && payload.bind.length > 0 ? payload.bind : '0.0.0.0';
      if (!remote.bindableAddresses().includes(bind)) {
        replyError(id, `The interface "${bind}" does not exist on this host.`);
        return;
      }
      const config: RemoteServerConfig = {
        enabled: payload.enabled === true,
        port: typeof payload.port === 'number' && Number.isInteger(payload.port) && payload.port > 0 && payload.port < 65536 ? payload.port : 9777,
        bind,
        allowPlainHttp: payload.allowPlainHttp === true,
      };
      await remote.configure(config);
      replyValue(id, { origin: remote.origin(), interfaces: remote.bindableAddresses() });
      return;
    }
    case 'remote.token.show': {
      if (!remote) {
        replyError(id, 'The worker core holds no remote server.');
        return;
      }
      replyValue(id, remote.readToken());
      return;
    }
    case 'remote.token.renew': {
      if (!remote) {
        replyError(id, 'The worker core holds no remote server.');
        return;
      }
      replyValue(id, await remote.renewToken());
      return;
    }
    case 'remote.qr': {
      if (!remote) {
        replyError(id, 'The worker core holds no remote server.');
        return;
      }
      replyValue(id, await remote.pairingQr());
      return;
    }
    case 'remote.password.set': {
      if (!remote || !isRecord(payload) || typeof payload.password !== 'string' || payload.password.length < 8) {
        replyError(id, 'The remote.password.set call needs an open remote server and a password of at least eight characters.');
        return;
      }
      await remote.setPassword(payload.password);
      replyValue(id, null);
      return;
    }
    case 'remote.password.clear': {
      if (!remote) {
        replyError(id, 'The worker core holds no remote server.');
        return;
      }
      await remote.clearPassword();
      replyValue(id, null);
      return;
    }
    default:
      replyError(id, `The worker core serves no channel "${channel}".`);
  }
}

/** Handles one message of the main process. */
async function handleMessage(message: unknown): Promise<void> {
  const candidate = message as MainToWorkerMessage | null;
  if (!candidate || typeof candidate !== 'object') {
    return;
  }
  if (candidate.kind === 'shutdown') {
    process.exit(0);
  }
  if (candidate.kind === 'callReply') {
    // The answer of one call the engine sent to the main process.
    const reply = candidate.reply;
    const waiting = reply ? mainCalls.get(reply.id) : undefined;
    if (!reply || !waiting) {
      return;
    }
    mainCalls.delete(reply.id);
    if (reply.ok) {
      waiting.resolve(reply.value ?? null);
      return;
    }
    waiting.reject(new Error(reply.error ?? 'The main process refused the call.'));
    return;
  }
  if (candidate.kind === 'request') {
    const request = candidate.request;
    if (!request || typeof request.id !== 'number' || typeof request.channel !== 'string') {
      return;
    }
    try {
      await serveRequest(request.id, request.channel, request.payload);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      log.worker.error(`request "${request.channel}" failed: ${text}`);
      replyError(request.id, text);
    }
    return;
  }
  if (candidate.kind === 'start') {
    const start = readWorkerStart(candidate.start);
    if (!start) {
      send({ kind: 'failed', message: 'The worker core received an invalid start message.' });
      return;
    }
    try {
      await openStorage(start);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      log.worker.error(`the storage of "${start.directoryPath}" did not open: ${text}`);
      send({ kind: 'failed', message: text });
      return;
    }
    log.worker.informative('worker core ready: storage open');
    send({ kind: 'ready' });
  }
}

port.on('message', (message) => {
  void handleMessage(message.data).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    log.worker.error(`unhandled message failure: ${text}`);
  });
});

// The log records of the worker cross to the main process, so its lines print under the app console.
bindRecordForwarder((record) => {
  send({ kind: 'log', record });
});

log.worker.informative('worker core booted, waiting for the start message');
