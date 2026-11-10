/**
 * Picks the working directory through the native directory dialog of the main process,
 * reached over the `nodewavenui` bridge.
 */

import { readBridge } from '../shared/bridge.js';
import { isWorkspaceDirectory, type WorkspaceDirectory } from '../shared/workspace.js';

/**
 * Reads a workspace directory out of an absolute path.
 *
 * @param path The absolute path of the selected folder.
 * @returns The workspace directory, or null when the path carries no name.
 */
function directoryFromPath(path: string): WorkspaceDirectory | null {
  const name = path.split(/[\\/]/).filter((part) => part.length > 0).pop();
  const candidate: unknown = name ? { name, path } : null;
  return isWorkspaceDirectory(candidate) ? candidate : null;
}

/**
 * Opens the native directory-selection dialog and waits for the user.
 *
 * @returns The selected directory, or null when the user dismissed the dialog.
 * A page outside the app also yields null, because no bridge serves the dialog there.
 */
export async function selectWorkspaceDirectory(): Promise<WorkspaceDirectory | null> {
  const bridge = readBridge();
  if (!bridge) {
    return null;
  }
  const path = await bridge.app.pickDirectory('Select a working directory');
  if (!path) {
    return null;
  }
  const candidate = directoryFromPath(path);
  return candidate ? (isWorkspaceDirectory(candidate) ? candidate : null) : null;
}
