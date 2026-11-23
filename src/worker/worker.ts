/**
 * The background core of the app: one utility process that owns the workspace storage, the
 * permission gate, the patch and task stores, the chat session files, and the remote control
 * server. The main process forks this module for every workspace window and speaks the core
 * contract over the parent port (`src/shared/core-api.ts`).
 */

import { bindRecordForwarder, log } from './logger.js';
import { JsonFileStorage } from '../storage/json-file.js';
import { readEncryptionSuite, type EncryptionSuiteId } from '../storage/encryption.js';
import type { StorageBackend } from '../storage/storage.js';
import { WorkspaceSettingsStore } from '../storage/settings-store.js';
import { nodeJsonFileFs } from './node-fs.js';
import { WorkerPermissionGate } from './permission-gate.js';
import { PatchStore } from './patch-store.js';
import { TaskStore } from './task-store.js';
import { ChatSessionStore } from './chat-sessions.js';
import { RemoteServer } from './remote-server.js';
import type { RemoteServerConfig } from '../storage/settings-store.js';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';
import type { PermissionTarget, PrincipalKind } from '../shared/permissions.js';
import { isRecord } from '../shared/records.js';
import {
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

/** The remote control server of the workspace. Null until the start message opened the storage. */
let remote: RemoteServer | null = null;

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
      sendChat: (fileId, text) => {
        send({ kind: 'chatSend', send: { fileId, text } });
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
