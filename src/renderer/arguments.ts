/**
 * The command line arguments of the app, read from the forwarded arguments of the NW.js App argv.
 * The print-and-quit arguments (`--version`, `--help`) run before any workspace opens.
 */

/** The app arguments the renderer reacts to. */
export interface AppArguments {
  /** Print the app version and quit. */
  readonly version: boolean;
  /** Print the argument help and quit. */
  readonly help: boolean;
  /** Expose the main app window to chats and the MCP host, like a child window. Dangerous. */
  readonly exposeMainWindow: boolean;
}

/** The help text of the `--help` argument. */
export const HELP_TEXT = `Arguments:
  --version                      Print the app version and quit.
  --help                         Print this help and quit.
  --mcp-host=<port>[:<iface>]    Start the MCP host. The default interface is 127.0.0.1.
  --expose-main-window           Expose the main window to chats and the MCP host. Dangerous.
  <workspace path>               Open this workspace at startup.`;

/** Reads the forwarded command line arguments of the running app. */
function forwardedArgv(): string[] {
  const argv: string[] = [];
  const processArgv = (globalThis as { process?: { argv?: unknown } }).process?.argv;
  if (Array.isArray(processArgv)) {
    argv.push(...processArgv.filter((item): item is string => typeof item === 'string'));
  }
  const appArgv = (globalThis as { nw?: { App?: { argv?: unknown } } }).nw?.App?.argv;
  if (Array.isArray(appArgv)) {
    argv.push(...appArgv.filter((item): item is string => typeof item === 'string'));
  }
  return argv;
}

/**
 * Reads the app arguments from the command line.
 *
 * @returns The present arguments.
 */
export function readAppArguments(): AppArguments {
  const argv = forwardedArgv();
  return {
    version: argv.includes('--version'),
    help: argv.includes('--help'),
    exposeMainWindow: argv.includes('--expose-main-window'),
  };
}

/**
 * Reads the version of the running app from the NW.js manifest.
 *
 * @returns The version string, or "0.0.0" when the manifest is unreachable.
 */
export function readAppVersion(): string {
  const manifest = (globalThis as { nw?: { App?: { manifest?: { version?: unknown } } } }).nw?.App?.manifest;
  const version = manifest?.version;
  return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
}
