/**
 * The app facts the renderer pages read over the `nodewavenui` bridge: the app root and the
 * platform. The bridge itself lives in `src/shared/bridge.ts`.
 */

import { readBridge } from '../shared/bridge.js';

/**
 * Reads the root directory of the app, the directory that holds the package.json.
 *
 * @returns The absolute directory path, or null outside an app window.
 */
export async function readAppRootPath(): Promise<string | null> {
  const bridge = readBridge();
  if (!bridge) {
    return null;
  }
  const root = await bridge.app.appRoot();
  return root.length > 0 ? root : null;
}
