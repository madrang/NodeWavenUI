/**
 * Shared filesystem access for the renderer pages, through the NW.js require global.
 * `fileSystem` answers the validated fs slice for callers that read error details, for example
 * the missing-file code of a marker read. The two silent helpers cover the callers that only
 * need a value or its absence: they answer with null on every failure, and the caller decides
 * what the failure means. Nothing here works outside NW.js.
 */

import { requireNodeModule } from '../shared/node-access.js';

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

/** The slice of the Node fs module the renderer uses. */
export interface NodeFileSystem {
  readdirSync(path: string): readonly string[];
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, contents: string): void;
}

/**
 * Reads the Node fs module with its shape validated.
 *
 * @returns The module, or null outside NW.js or when the shape does not match.
 */
export function fileSystem(): NodeFileSystem | null {
  const module = requireNodeModule('fs');
  if (module === null || typeof module !== 'object') {
    return null;
  }
  const fs = module as Partial<NodeFileSystem>;
  return typeof fs.readdirSync === 'function' && typeof fs.readFileSync === 'function' && typeof fs.writeFileSync === 'function'
    ? (fs as NodeFileSystem)
    : null;
}

/**
 * Lists the file and folder names of one directory.
 *
 * @param directory The absolute directory path.
 * @returns The names, or null when the filesystem is unreachable or the directory cannot be read.
 */
export function listDirectoryNames(directory: string): readonly string[] | null {
  const fs = fileSystem();
  if (fs === null) {
    return null;
  }
  try {
    return fs.readdirSync(directory).filter((name): name is string => typeof name === 'string');
  } catch {
    return null;
  }
}

/**
 * Reads one text file.
 *
 * @param path The absolute file path.
 * @returns The file text, or null when the filesystem is unreachable or the file cannot be read.
 */
export function readTextFile(path: string): string | null {
  const fs = fileSystem();
  if (fs === null) {
    return null;
  }
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
