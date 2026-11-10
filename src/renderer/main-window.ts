/**
 * Opens the workspace window and hands it the startup payload.
 * The main process opens the window and holds the payload in memory until the new page receives
 * it. The frame mode decides the window chrome at creation, because a live window cannot change
 * its frame. The workspace page validates the payload itself and closes on failure, so the
 * launch call resolves once the window opened, not once the page booted.
 */

import { readBridge } from '../shared/bridge.js';
import type { MainHandoffPayload } from './main-handoff.js';

/**
 * Opens the workspace window and delivers the payload.
 *
 * @param payload The handoff payload for the workspace window.
 * @throws Error when the page runs outside an app window or the main process refuses the open.
 */
export async function launchMainWindow(payload: MainHandoffPayload): Promise<void> {
  const bridge = readBridge();
  if (!bridge) {
    throw new Error('The workspace window could not open. The nodewavenui bridge is not available.');
  }
  await bridge.windows.openWorkspace(payload);
}
