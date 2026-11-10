/**
 * The command line arguments and the version of the app, read over the `nodewavenui` bridge.
 * The print-and-quit arguments (`--version`, `--help`) run before any workspace opens.
 */

import { readBridge } from '../shared/bridge.js';

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

/**
 * Reads the app arguments from the command line.
 *
 * @returns The present arguments. No bridge yields the empty set.
 */
export async function readAppArguments(): Promise<AppArguments> {
  const bridge = readBridge();
  const argv = bridge ? await bridge.app.arguments() : [];
  return {
    version: argv.includes('--version'),
    help: argv.includes('--help'),
    exposeMainWindow: argv.includes('--expose-main-window'),
  };
}

/**
 * Reads the version of the running app.
 *
 * @returns The version string, or "0.0.0" when the bridge is missing.
 */
export async function readAppVersion(): Promise<string> {
  const bridge = readBridge();
  if (!bridge) {
    return '0.0.0';
  }
  const version = await bridge.app.version();
  return version.length > 0 ? version : '0.0.0';
}
