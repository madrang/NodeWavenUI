/**
 * Picks the working directory through the NW.js nwdirectory input.
 * NW.js 0.117.0 and newer crash on Linux after a selection: the file-select helper hands Chromium an empty base_dir, which a CHECK kills.
 * The app pins nw 0.116.0, the last verified-good version; the crash was version-based, so the title and accept-label attributes ride along safely.
 * NW.js reports the selected folder on the input value and on the first file path.
 */

import { getNwFilePath } from '../shared/nw.js';
import { isWorkspaceDirectory, type WorkspaceDirectory } from '../shared/workspace.js';

/**
 * Reads a workspace directory out of an absolute path.
 *
 * @param path The absolute path of the selected folder.
 * @returns The workspace directory, or null when the path carries no name.
 */
function directoryFromPath(path: string): WorkspaceDirectory | null {
  const name = path.split(/[\\/]/).filter((part) => part.length > 0).pop();
  const candidate: unknown = name === undefined ? null : { name, path };
  return isWorkspaceDirectory(candidate) ? candidate : null;
}

/**
 * Opens the NW.js directory-selection input and waits for the user.
 *
 * @returns The selected directory, or null when the user dismissed the dialog.
 */
function selectWithNwInput(): Promise<WorkspaceDirectory | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('nwdirectory', '');
    // The title override is documented. The confirm button keeps the Chromium upload-folder label ("Upload"), because NW.js maps nwdirectory to that dialog type and exposes no accept-label attribute.
    input.setAttribute('nwdirectorydesc', 'Select a working directory');
    input.hidden = true;
    let settled = false;
    const settle = (directory: WorkspaceDirectory | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(directory);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      const path = file !== undefined ? getNwFilePath(file) : null;
      const chosen = path ?? (input.value.length > 0 ? input.value : null);
      const candidate: unknown = chosen === null ? null : directoryFromPath(chosen);
      settle(isWorkspaceDirectory(candidate) ? candidate : null);
    });
    input.addEventListener('cancel', () => {
      settle(null);
    });
    // Some NW.js builds fire no cancel event on dismissal, so a return of focus with no files settles the call.
    window.addEventListener('focus', () => {
      window.setTimeout(() => {
        if (!settled && (input.files?.length ?? 0) === 0) {
          settle(null);
        }
      }, 250);
    });
    document.body.append(input);
    // NW.js leaves a stale value on reused inputs; the nw-programmatic-folder-select workaround clears it.
    (input.files as FileList & { clear?: () => void }).clear?.();
    input.click();
  });
}

/**
 * Opens the NW.js directory-selection dialog and waits for the user.
 *
 * @returns The selected directory, or null when the user dismissed the dialog.
 * A page outside NW.js also yields null, because the selection then carries no filesystem path.
 */
export function selectWorkspaceDirectory(): Promise<WorkspaceDirectory | null> {
  return selectWithNwInput();
}
