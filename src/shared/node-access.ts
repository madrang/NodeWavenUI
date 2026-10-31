/**
 * Access to the Node globals of the NW.js page context, shared by every compile context.
 * The renderer, storage, and plugin modules import these helpers, so each context holds
 * exactly one implementation. Nothing here works outside NW.js.
 */

/**
 * Reads the Node require global of the NW.js page context.
 *
 * @returns The require function, or null when the page runs without the NW.js Node context.
 */
export function nodeRequire(): ((id: string) => unknown) | null {
  const candidate = (globalThis as { require?: unknown }).require;
  return typeof candidate === 'function' ? (candidate as (id: string) => unknown) : null;
}

/**
 * Loads one Node module through the NW.js require global.
 *
 * @param id The module id, for example "fs".
 * @returns The module exports, or null when require is missing or the module fails to load.
 */
export function requireNodeModule(id: string): unknown {
  const require = nodeRequire();
  if (require === null) {
    return null;
  }
  try {
    return require(id);
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
