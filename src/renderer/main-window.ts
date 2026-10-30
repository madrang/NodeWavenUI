/**
 * Opens the workspace window and hands it the startup payload.
 * The frame mode decides the window chrome at creation: NW.js cannot change the frame of a live
 * window. The launcher waits until the workspace window reports readiness, then closes itself.
 */

import { openChildWindow, type NwChildWindow } from '../shared/nw.js';
import {
  MAIN_HANDOFF_RECEIVER_NAME,
  type MainHandoffCallbacks,
  type MainHandoffPayload,
  type MainHandoffReceiver,
} from './main-handoff.js';

/** The size the workspace window opens with. A stored geometry restores over it. */
const WORKSPACE_WINDOW_SIZE = { width: 760, height: 680 } as const;

/** How long the launcher waits for the workspace window to load and report readiness. */
const HANDOFF_TIMEOUT_MILLISECONDS = 20000;

/**
 * Reads the handoff receiver the workspace window exposes.
 *
 * @param childWindow The opened workspace window.
 * @returns The receiver, or null while its module has not run.
 */
function readReceiver(childWindow: NwChildWindow): MainHandoffReceiver | null {
  const dom = childWindow.window;
  if (typeof dom !== 'object' || dom === null) {
    return null;
  }
  const receiver = (dom as unknown as Record<string, unknown>)[MAIN_HANDOFF_RECEIVER_NAME];
  return typeof receiver === 'function' ? (receiver as MainHandoffReceiver) : null;
}

/**
 * Opens the workspace window, delivers the payload, and waits for its report.
 *
 * @param payload The handoff payload for the workspace window.
 * @throws Error when the window does not open, does not load, or reports a failure. A failed window closes.
 */
export async function launchMainWindow(payload: MainHandoffPayload): Promise<void> {
  const url = new URL('main.html', globalThis.location.href).href;
  const frame = payload.frameMode === 'system';
  const workspaceWindow = await openChildWindow(url, {
    width: WORKSPACE_WINDOW_SIZE.width,
    height: WORKSPACE_WINDOW_SIZE.height,
    frame,
    // The borderless mode keeps the transparent window that rounds the corners.
    transparent: !frame,
  });
  if (workspaceWindow === null) {
    throw new Error('The workspace window could not open. The NW.js window API is not available.');
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      if (error === null) {
        resolve();
        return;
      }
      workspaceWindow.close();
      reject(error);
    };
    const timeout = window.setTimeout(() => {
      finish(new Error('The workspace window did not report readiness in time.'));
    }, HANDOFF_TIMEOUT_MILLISECONDS);
    const deliver = (): void => {
      const receiver = readReceiver(workspaceWindow);
      if (receiver === null) {
        finish(new Error('The workspace window did not expose its startup receiver.'));
        return;
      }
      const callbacks: MainHandoffCallbacks = {
        onReady: () => {
          finish(null);
        },
        onFailed: (message) => {
          finish(new Error(message));
        },
      };
      try {
        receiver(payload, callbacks);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    let delivered = false;
    workspaceWindow.on('loaded', () => {
      if (delivered) {
        return;
      }
      delivered = true;
      deliver();
    });
    // nw.Window.open can resolve after the page loaded, so an immediate probe catches that case.
    if (readReceiver(workspaceWindow) !== null) {
      delivered = true;
      deliver();
    }
  });
}
