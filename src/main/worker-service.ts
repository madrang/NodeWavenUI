/**
 * The worker link of the main process: it forks the background core for one workspace, feeds it
 * the start data, relays the core requests of the renderers into it, and answers the calls the
 * core sends back for the services that stayed in main. The state changes of the worker push over
 * the workspace link, so the page sees the same lifecycle every surface sees, and the log records
 * of the worker land in the console hierarchy of the app.
 */

import { app, ipcMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import type { Logger } from '../shared/logging.js';
import { EventLevels } from '../shared/logging.js';
import { pushWorkspace, workspaceContents } from './workspace-link.js';
import { serveWorkerCall } from './tool-runner.js';
import {
  CORE_REQUEST_CHANNELS,
  WORKER_STORAGE_IDS,
  type CoreReply,
  type CoreRequest,
  type CoreStatus,
  type MainToWorkerMessage,
  type WorkerLogRecord,
  type WorkerStart,
  type WorkerToMainMessage,
} from '../shared/core-api.js';

/** The ipc channel prefix every bridge call shares. */
const CHANNEL = 'nodewavenui';

/** The app root, one level above the compiled main directory. */
const APP_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, ''));

/** The module of the worker core, under the app root. */
const WORKER_MODULE = join(APP_ROOT, 'dist', 'worker', 'worker.js');

/** The running worker of the open workspace. Null when none runs. */
let worker: UtilityProcess | null = null;

/** The state of the running worker. Null when none runs. */
let status: CoreStatus | null = null;

/** The pending core requests, keyed by request id. */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

/** The id of the next core request. */
let nextRequestId = 1;

/** The milliseconds one core request may take. The permission channels wait for a user answer,
 * so no timeout applies to them. */
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

/** Reads the method name of one event level. Falls back to informative. */
function levelMethodName(level: number): string {
  for (const [name, value] of Object.entries(EventLevels)) {
    if (value === level) {
      return name.toLowerCase();
    }
  }
  return 'informative';
}

/** Walks one logger record into the console hierarchy of the main process. */
function forwardLogRecord(record: WorkerLogRecord): void {
  let logger: Logger = log;
  for (const part of record.name.split('->')) {
    if (part.length > 0) {
      logger = logger[part];
    }
  }
  logger[levelMethodName(record.level)](...record.args);
}

/** Applies one state change and pushes it to the workspace page. */
function setState(next: CoreStatus): void {
  status = next;
  pushWorkspace('core.state', next);
}

/** Sends one message to the worker. Nothing goes anywhere without a running worker. */
function send(message: MainToWorkerMessage): void {
  worker?.postMessage(message);
}

/**
 * Forks the background core for one workspace.
 * A start on a storage setup the worker cannot open fails at once, without a fork.
 *
 * @param start The start data of the workspace.
 */
export function startWorkspaceWorker(start: WorkerStart): void {
  stopWorkspaceWorker();
  if (!WORKER_STORAGE_IDS.includes(start.storageId)) {
    log.worker.warning(`the storage "${start.storageId}" cannot open in the worker core.`);
    setState({ state: 'failed', error: `The storage "${start.storageId}" of this workspace cannot open in the worker core.` });
    return;
  }
  status = { state: 'starting' };
  if (!existsSync(WORKER_MODULE)) {
    const message = `The worker module is missing: ${WORKER_MODULE}`;
    log.worker.error(message);
    setState({ state: 'failed', error: message });
    return;
  }
  worker = utilityProcess.fork(WORKER_MODULE, [], { serviceName: 'nodewavenui-core', stdio: 'pipe' });
  // The log records carry every printed line to the main hierarchy, so the worker stdout stays
  // unread. The stderr keeps flowing, so a boot crash still shows its stack.
  worker.stderr?.pipe(process.stderr);
  worker.on('message', (message: WorkerToMainMessage) => {
    if (message.kind === 'ready') {
      setState({ state: 'ready' });
      return;
    }
    if (message.kind === 'failed') {
      log.worker.error(`the worker core failed: ${message.message}`);
      setState({ state: 'failed', error: message.message });
      return;
    }
    if (message.kind === 'reply') {
      settleReply(message.reply);
      return;
    }
    if (message.kind === 'log') {
      forwardLogRecord(message.record);
      return;
    }
    if (message.kind === 'event') {
      pushWorkspace(message.event.channel, message.event.payload);
      return;
    }
    if (message.kind === 'call') {
      // The chat engine of the worker reaches the services that stayed in main: the window and
      // command tools, and the MCP client. The answer travels back as one call reply.
      void serveWorkerCall(message.call).then((reply) => {
        send({ kind: 'callReply', reply });
      });
    }
  });
  const instance = worker;
  worker.on('exit', (code) => {
    // The exit of a worker another start replaced changes nothing: it speaks of the old core.
    if (worker !== instance) {
      return;
    }
    const failure = `The worker core exited (code ${String(code)}).`;
    log.worker.warning(failure);
    worker = null;
    rejectPending(new Error(failure));
    if (!status || status.state !== 'failed') {
      setState({ state: 'failed', error: failure });
    }
  });
  log.worker.informative(`worker core forked from ${WORKER_MODULE}, sending the start message`);
  send({ kind: 'start', start });
}

/** Stops the worker of the open workspace. A repeated call changes nothing. */
export function stopWorkspaceWorker(): void {
  const current = worker;
  worker = null;
  rejectPending(new Error('The worker core stopped.'));
  if (current) {
    status = null;
    current.kill();
  }
}

/** Resolves one reply of the worker into its pending request. */
function settleReply(reply: CoreReply): void {
  const entry = pending.get(reply.id);
  if (!entry) {
    return;
  }
  pending.delete(reply.id);
  if (reply.ok) {
    entry.resolve(reply.value ?? null);
    return;
  }
  entry.reject(new Error(reply.error ?? 'The worker core refused the request.'));
}

/** Rejects every pending request with one error. */
function rejectPending(error: Error): void {
  for (const [, entry] of pending) {
    entry.reject(error);
  }
  pending.clear();
}

/** True when one ipc sender is the workspace window, the only surface the core slice serves.
 * Its same-origin iframes ride the same web contents; plugin pages and webview guests answer
 * from their own. */
function isCoreSurface(sender: WebContents): boolean {
  const workspace = workspaceContents();
  return workspace !== null && sender === workspace;
}

/**
 * Runs one core request against the worker.
 *
 * @param channel The request channel of the core contract.
 * @param payload The payload of the request.
 * @returns The reply value of the worker.
 * @throws Error when no worker runs, the channel sits outside the contract, or the worker fails.
 */
export function coreRequest(channel: string, payload: unknown): Promise<unknown> {
  if (!worker || !status || status.state !== 'ready') {
    const error = status?.error ?? 'The worker core of this workspace does not run.';
    return Promise.reject(new Error(error));
  }
  if (!CORE_REQUEST_CHANNELS.includes(channel as (typeof CORE_REQUEST_CHANNELS)[number])) {
    return Promise.reject(new Error(`The channel "${channel}" sits outside the core contract.`));
  }
  const request: CoreRequest = { id: nextRequestId, channel, payload };
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    // A permission check waits for a user answer on a card, so it carries no timeout.
    const timeout = channel.startsWith('permission.') ?
      undefined :
      setTimeout(() => {
        const entry = pending.get(request.id);
        if (!entry) {
          return;
        }
        pending.delete(request.id);
        entry.reject(new Error(`The core request "${channel}" timed out.`));
      }, REQUEST_TIMEOUT_MILLISECONDS);
    pending.set(request.id, {
      resolve: (value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      },
      reject: (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      },
    });
    send({ kind: 'request', request });
  });
}

/** Installs the core slice handlers of the bridge. Runs once the app is ready. */
export function registerWorkerService(): void {
  ipcMain.handle(`${CHANNEL}:core:request`, (event, channel: unknown, payload: unknown) => {
    if (!isCoreSurface(event.sender)) {
      throw new Error('The background core serves the workspace window only.');
    }
    if (typeof channel !== 'string') {
      throw new Error('The core request needs a channel string.');
    }
    return coreRequest(channel, payload);
  });
  ipcMain.handle(`${CHANNEL}:core:status`, (event) => {
    if (!isCoreSurface(event.sender)) {
      throw new Error('The background core serves the workspace window only.');
    }
    return status;
  });
  app.on('will-quit', () => {
    stopWorkspaceWorker();
  });
}
