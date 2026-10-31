/**
 * NW.js globals the renderer pages read.
 * The Node require global and the platform read live in `src/shared/node-access.ts`,
 * which every compile context shares.
 */

/** The slice of the Node child_process module the renderer uses. */
export interface NodeChildProcess {
  execFile?: (
    command: string,
    args: readonly string[],
    callback: (error: unknown, stdout: string) => void,
  ) => unknown;
}

/**
 * Reads the root directory of the app, the directory that holds the package.json.
 * The NW.js start path is the reliable source; the working directory is the fallback,
 * because NW.js starts the process there for an unpacked app.
 *
 * @returns The absolute directory path, or null outside NW.js or when neither source reports a string.
 */
export function readAppRootPath(): string | null {
  const nw = (globalThis as { nw?: { App?: { startPath?: unknown } } }).nw;
  if (typeof nw?.App?.startPath === 'string' && nw.App.startPath.length > 0) {
    return nw.App.startPath;
  }
  const process = (globalThis as { process?: { cwd?: unknown } }).process;
  if (typeof process?.cwd === 'function') {
    try {
      const cwd = (process.cwd as () => unknown)();
      if (typeof cwd === 'string' && cwd.length > 0) {
        return cwd;
      }
    } catch {
      return null;
    }
  }
  return null;
}
