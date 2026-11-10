/**
 * Workspace folder inspection and marker file handling.
 * The pages reach the filesystem through the `nodewavenui` bridge, so these functions work only
 * inside an app window.
 */

import { WORKSPACE_MARKER_FILE, isWorkspaceSettings, type WorkspaceSettings } from '../shared/workspace.js';
import { joinPath, listDirectoryNames, readTextFile, writeTextFile } from './file-system.js';

/**
 * Lists the entries of a folder.
 *
 * @param directory The absolute folder path.
 * @returns The entry names, or null when the folder cannot be read.
 */
export async function readDirectoryEntries(directory: string): Promise<string[] | null> {
  const names = await listDirectoryNames(directory);
  return names ? [...names] : null;
}

/**
 * Reads the workspace marker of a folder.
 *
 * @param directory The absolute folder path.
 * @returns The workspace settings from the marker, or null when no valid marker exists.
 */
export async function readWorkspaceMarker(directory: string): Promise<WorkspaceSettings | null> {
  const path = joinPath(directory, WORKSPACE_MARKER_FILE);
  const contents = await readTextFile(path);
  if (!contents) {
    // A missing marker is the normal state of a fresh folder, and a read failure stays equally
    // quiet: both leave the folder fresh for the wizard.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    console.warn(`[NodeWavenUI] the workspace marker of "${directory}" is not valid JSON. The wizard reinitializes it.`);
    return null;
  }
  if (isWorkspaceSettings(parsed)) {
    return parsed;
  }
  console.warn(`[NodeWavenUI] the workspace marker of "${directory}" carries an invalid shape. The wizard reinitializes it.`);
  return null;
}

/**
 * Writes the workspace marker into a folder.
 *
 * @param directory The absolute folder path.
 * @param settings The workspace settings to persist.
 * @returns An error message, or null on success.
 */
export async function writeWorkspaceMarker(directory: string, settings: WorkspaceSettings): Promise<string | null> {
  try {
    await writeTextFile(joinPath(directory, WORKSPACE_MARKER_FILE), `${JSON.stringify(settings, null, 2)}\n`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
