/**
 * Workspace folder inspection and marker file handling.
 * The NW.js page context reaches the filesystem through its Node require global, so these functions work only inside NW.js.
 */

import { WORKSPACE_MARKER_FILE, isWorkspaceSettings, type WorkspaceSettings } from '../shared/workspace.js';
import { requireNodeModule } from './node-context.js';

/** The slice of the Node fs module this file uses. */
interface NodeFs {
  readdirSync?: (path: string) => string[];
  readFileSync?: (path: string, encoding: string) => string;
  writeFileSync?: (path: string, contents: string) => void;
}

function fs(): NodeFs | null {
  const module = requireNodeModule('fs');
  if (typeof module !== 'object' || module === null) {
    return null;
  }
  return module as NodeFs;
}

function joinPath(directory: string, file: string): string {
  return `${directory.replace(/[\\/]+$/, '')}/${file}`;
}

/**
 * Lists the entries of a folder.
 *
 * @param directory The absolute folder path.
 * @returns The entry names, or null when the filesystem is unreachable or the folder cannot be read.
 */
export function readDirectoryEntries(directory: string): string[] | null {
  const nodeFs = fs();
  if (nodeFs === null || typeof nodeFs.readdirSync !== 'function') {
    return null;
  }
  try {
    return nodeFs.readdirSync(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the folder "${directory}" could not be read: ${message}`);
    return null;
  }
}

/**
 * Reads the workspace marker of a folder.
 *
 * @param directory The absolute folder path.
 * @returns The workspace settings from the marker, or null when no valid marker exists.
 */
export function readWorkspaceMarker(directory: string): WorkspaceSettings | null {
  const nodeFs = fs();
  if (nodeFs === null || typeof nodeFs.readFileSync !== 'function') {
    return null;
  }
  let contents: string;
  try {
    contents = nodeFs.readFileSync(joinPath(directory, WORKSPACE_MARKER_FILE), 'utf8');
  } catch (error) {
    // A missing marker is the normal state of a fresh folder. Every other failure hides a real problem.
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the workspace marker of "${directory}" could not be read: ${message}`);
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
export function writeWorkspaceMarker(directory: string, settings: WorkspaceSettings): string | null {
  const nodeFs = fs();
  if (nodeFs === null || typeof nodeFs.writeFileSync !== 'function') {
    return 'The filesystem is not reachable. Start the app under NW.js.';
  }
  try {
    nodeFs.writeFileSync(joinPath(directory, WORKSPACE_MARKER_FILE), `${JSON.stringify(settings, null, 2)}\n`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
