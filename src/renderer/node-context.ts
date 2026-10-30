/**
 * Access to Node modules from the NW.js page context.
 * The NW.js page context exposes the Node require global, which reaches the filesystem and child processes.
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
 * Loads one Node module through the NW.js require global.
 *
 * @param id The module id, for example "fs".
 * @returns The module exports, or null when require is missing or the module fails to load.
 */
export function requireNodeModule(id: string): unknown {
  const require = (globalThis as { require?: unknown }).require;
  if (typeof require !== 'function') {
    return null;
  }
  try {
    return (require as (moduleId: string) => unknown)(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the Node module "${id}" could not be loaded: ${message}`);
    return null;
  }
}

/**
 * Reads the platform of the running process.
 *
 * @returns The platform id, for example "linux" or "win32", or "unknown" outside NW.js.
 */
export function currentPlatform(): string {
  const process = (globalThis as { process?: { platform?: unknown } }).process;
  return typeof process?.platform === 'string' ? process.platform : 'unknown';
}
