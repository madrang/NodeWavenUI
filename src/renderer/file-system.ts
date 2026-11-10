/**
 * Shared filesystem access for the renderer pages, through the `nodewavenui` bridge of the
 * preload. The read helpers answer with null on every failure, and the caller decides what the
 * failure means. The mutations pass the bridge error through. Nothing here works outside an app
 * window of the Electron main process.
 */

import { readBridge } from '../shared/bridge.js';

/** Reads the bridge, or throws when the page runs outside the app. */
function bridge() {
  const bridge = readBridge();
  if (!bridge) {
    throw new Error('The filesystem needs the nodewavenui bridge of an app window.');
  }
  return bridge;
}

/**
 * Joins a directory path and a file name into one path.
 * A trailing slash of the directory drops, so the joined path carries exactly one separator.
 *
 * @param directory The absolute directory path.
 * @param file The file or folder name.
 * @returns The joined path.
 */
export function joinPath(directory: string, file: string): string {
  return `${directory.replace(/[\\/]+$/, '')}/${file}`;
}

/**
 * Lists the file and folder names of one directory.
 *
 * @param directory The absolute directory path.
 * @returns The names, or null when the bridge is missing or the directory cannot be read.
 */
export async function listDirectoryNames(directory: string): Promise<readonly string[] | null> {
  try {
    return await bridge().fs.list(directory);
  } catch {
    return null;
  }
}

/**
 * Reads one text file.
 *
 * @param path The absolute file path.
 * @returns The file text, or null when the bridge is missing or the file cannot be read.
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await bridge().fs.readText(path);
  } catch {
    return null;
  }
}

/**
 * Reads one file as bytes.
 *
 * @param path The absolute file path.
 * @returns The bytes, or null when the bridge is missing or the file cannot be read.
 */
export async function readDataFile(path: string): Promise<Uint8Array | null> {
  try {
    return await bridge().fs.readData(path);
  } catch {
    return null;
  }
}

/**
 * Writes one text file, replacing what it held.
 *
 * @param path The absolute file path.
 * @param text The text to write.
 * @throws Error when the bridge is missing or the file cannot be written.
 */
export async function writeTextFile(path: string, text: string): Promise<void> {
  await bridge().fs.writeText(path, text);
}

/**
 * Writes one file from bytes, replacing what it held.
 *
 * @param path The absolute file path.
 * @param data The bytes to write.
 * @throws Error when the bridge is missing or the file cannot be written.
 */
export async function writeDataFile(path: string, data: Uint8Array): Promise<void> {
  await bridge().fs.writeData(path, data);
}

/**
 * Creates one directory, with every missing parent.
 *
 * @param path The absolute directory path.
 * @throws Error when the bridge is missing or the directory cannot be created.
 */
export async function makeDirectory(path: string): Promise<void> {
  await bridge().fs.makeDirectory(path);
}

/**
 * Removes one file or directory tree, also when partly absent.
 *
 * @param path The absolute path.
 * @throws Error when the bridge is missing or the path cannot be removed.
 */
export async function removePath(path: string): Promise<void> {
  await bridge().fs.remove(path);
}

/**
 * Renames or moves one file or directory.
 *
 * @param from The absolute source path.
 * @param to The absolute target path.
 * @throws Error when the bridge is missing or the move fails.
 */
export async function renamePath(from: string, to: string): Promise<void> {
  await bridge().fs.rename(from, to);
}

/**
 * Reads one path.
 *
 * @param path The absolute path.
 * @returns The stat with its directory flag, or null when the bridge is missing or nothing sits there.
 */
export async function statPath(path: string): Promise<{ directory: boolean } | null> {
  try {
    const stat = await bridge().fs.stat(path);
    return stat ? { directory: stat.directory } : null;
  } catch {
    return null;
  }
}
