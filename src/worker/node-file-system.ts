/**
 * Shared filesystem access for the worker core, over node:fs. The helpers mirror the renderer
 * fs module (`src/renderer/file-system.ts`): the read helpers answer with null on every failure,
 * and the caller decides what the failure means. The mutations throw, so a failed write surfaces.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';

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
 * @returns The names, or null when the directory cannot be read.
 */
export async function listDirectoryNames(directory: string): Promise<readonly string[] | null> {
  try {
    return await readdir(directory);
  } catch {
    return null;
  }
}

/**
 * Reads one text file.
 *
 * @param path The absolute file path.
 * @returns The file text, or null when the file cannot be read.
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Reads one file as bytes.
 *
 * @param path The absolute file path.
 * @returns The bytes, or null when the file cannot be read.
 */
export async function readDataFile(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

/**
 * Writes one text file, replacing what it held.
 *
 * @param path The absolute file path.
 * @param text The text to write.
 * @throws Error when the file cannot be written.
 */
export async function writeTextFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, 'utf-8');
}

/**
 * Writes one file from bytes, replacing what it held.
 *
 * @param path The absolute file path.
 * @param data The bytes to write.
 * @throws Error when the file cannot be written.
 */
export async function writeDataFile(path: string, data: Uint8Array): Promise<void> {
  await writeFile(path, data);
}

/**
 * Creates one directory, with every missing parent.
 *
 * @param path The absolute directory path.
 * @throws Error when the directory cannot be created.
 */
export async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Removes one file or directory tree, also when partly absent.
 *
 * @param path The absolute path.
 * @throws Error when the path cannot be removed.
 */
export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Renames or moves one file or directory.
 *
 * @param from The absolute source path.
 * @param to The absolute target path.
 * @throws Error when the move fails.
 */
export async function renamePath(from: string, to: string): Promise<void> {
  await rename(from, to);
}

/**
 * Reads one path.
 *
 * @param path The absolute path.
 * @returns The stat with its directory flag, or null when nothing sits there.
 */
export async function statPath(path: string): Promise<{ directory: boolean } | null> {
  try {
    const info = await stat(path);
    return { directory: info.isDirectory() };
  } catch {
    return null;
  }
}
