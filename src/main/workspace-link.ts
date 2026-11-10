/**
 * The link between the main process and the workspace window. The main services call into the
 * workspace page — permission checks, storage reads — and push events back — MCP session
 * traffic. A request carries one id; the reply closes the wait. No timeout applies, because a
 * permission check can wait for a user answer on a card.
 */

import { ipcMain, webContents, type WebContents } from 'electron';

/** The ipc channel prefix every bridge call shares. */
const CHANNEL = 'nodewavenui';

/** The pending workspace requests, keyed by id. */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

/** The next request id. */
let nextId = 1;

/** The web contents of the open workspace window, or null while none is open. */
let workspace: WebContents | null = null;

/**
 * Remembers the web contents of the workspace window. The window service calls this when the
 * workspace opens; a destroyed contents clears itself.
 *
 * @param contents The web contents of the workspace window.
 */
export function setWorkspaceContents(contents: WebContents): void {
  workspace = contents;
  contents.once('destroyed', () => {
    if (workspace === contents) {
      workspace = null;
    }
  });
}

/** Reads the web contents of the workspace window, or null while none is open. */
export function workspaceContents(): WebContents | null {
  return workspace && !workspace.isDestroyed() ? workspace : null;
}

/** Installs the reply listener. Runs once the app is ready. */
export function registerWorkspaceLink(): void {
  ipcMain.on(`${CHANNEL}:workspace:reply`, (_event, reply: unknown) => {
    const candidate = reply as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown } | null;
    if (typeof candidate?.id !== 'number') {
      return;
    }
    const request = pending.get(candidate.id);
    if (!request) {
      return;
    }
    pending.delete(candidate.id);
    if (candidate.ok) {
      request.resolve(candidate.value);
      return;
    }
    request.reject(new Error(typeof candidate.error === 'string' ? candidate.error : 'The workspace request failed.'));
  });
}

/**
 * Calls one channel of the workspace page and waits for its answer.
 *
 * @param channel The channel name the workspace page serves.
 * @param payload The call payload.
 * @returns The answer of the workspace page.
 * @throws Error when no workspace window is open or the page reports a failure.
 */
export async function callWorkspace<T>(channel: string, payload: unknown): Promise<T> {
  const contents = workspaceContents();
  if (!contents) {
    throw new Error('No workspace window is open, so the workspace link cannot serve this call.');
  }
  const id = nextId;
  nextId += 1;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    contents.send(`${CHANNEL}:workspace:request`, { id, channel, payload });
  });
}

/**
 * Pushes one event to the workspace page without waiting for an answer.
 *
 * @param channel The event channel name.
 * @param payload The event payload.
 */
export function pushWorkspace(channel: string, payload: unknown): void {
  workspaceContents()?.send(`${CHANNEL}:workspace:event`, { channel, payload });
}

/** Reads the web contents behind an id, for the session tools that address children by id. */
export function contentsById(id: number): WebContents | null {
  const contents = webContents.getAllWebContents().find((candidate) => candidate.id === id);
  return contents ?? null;
}
