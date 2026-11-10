/**
 * The ipc services of the main process: the fs slice, the app facts, and the native directory
 * picker. Every handler validates its arguments, because the values cross from a sandboxed page.
 */

import { app, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { loadPluginEntry } from './plugin-host.js';

/** The ipc channel prefix every bridge call shares. */
const CHANNEL = 'nodewavenui';

/**
 * Reads one string argument.
 *
 * @param value The value the page sent.
 * @param name The argument name, for the error text.
 * @returns The string.
 * @throws Error when the value is no non-empty string.
 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The argument "${name}" needs a non-empty string.`);
  }
  return value;
}

/** The absolute path of the app root, one level above the compiled main directory. */
function appRoot(): string {
  return resolve(import.meta.dirname, '../..');
}

/**
 * The app arguments after the executable and the entry script, so the pages read the same
 * `--mcp-host`, `--expose-main-window`, and positional workspace path the NW.js app served.
 */
function appArguments(): string[] {
  const dropped = new Set([process.execPath, resolve(process.argv[1] ?? '')]);
  return process.argv.filter((argument) => !dropped.has(argument) && !dropped.has(resolve(argument)));
}

/** Installs every bridge service handler. Runs once the app is ready. */
export function registerServices(): void {
  ipcMain.handle(`${CHANNEL}:fs:list`, (_event, directory: unknown) =>
    fs.promises.readdir(requireString(directory, 'directory')),
  );
  ipcMain.handle(`${CHANNEL}:fs:readText`, (_event, path: unknown) =>
    fs.promises.readFile(requireString(path, 'path'), 'utf-8'),
  );
  ipcMain.handle(`${CHANNEL}:fs:readData`, async (_event, path: unknown) =>
    new Uint8Array(await fs.promises.readFile(requireString(path, 'path'))),
  );
  ipcMain.handle(`${CHANNEL}:fs:writeText`, (_event, path: unknown, text: unknown) =>
    fs.promises.writeFile(requireString(path, 'path'), requireString(text, 'text'), 'utf-8'),
  );
  ipcMain.handle(`${CHANNEL}:fs:writeData`, (_event, path: unknown, data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      throw new Error('The argument "data" needs bytes.');
    }
    return fs.promises.writeFile(requireString(path, 'path'), data);
  });
  ipcMain.handle(`${CHANNEL}:fs:makeDirectory`, (_event, path: unknown) =>
    fs.promises.mkdir(requireString(path, 'path'), { recursive: true }),
  );
  ipcMain.handle(`${CHANNEL}:fs:remove`, (_event, path: unknown) =>
    fs.promises.rm(requireString(path, 'path'), { force: true, recursive: true }),
  );
  ipcMain.handle(`${CHANNEL}:fs:rename`, (_event, from: unknown, to: unknown) =>
    fs.promises.rename(requireString(from, 'from'), requireString(to, 'to')),
  );
  ipcMain.handle(`${CHANNEL}:fs:stat`, async (_event, path: unknown) => {
    try {
      const stat = await fs.promises.stat(requireString(path, 'path'));
      return { exists: true, directory: stat.isDirectory() };
    } catch {
      return null;
    }
  });

  ipcMain.handle(`${CHANNEL}:app:version`, () => app.getVersion());
  ipcMain.handle(`${CHANNEL}:app:arguments`, () => appArguments());
  ipcMain.handle(`${CHANNEL}:app:appRoot`, () => appRoot());
  ipcMain.handle(`${CHANNEL}:app:platform`, () => process.platform);
  ipcMain.handle(`${CHANNEL}:app:pickDirectory`, async (_event, title: unknown) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: typeof title === 'string' && title.length > 0 ? title : 'Select a directory',
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(`${CHANNEL}:plugins:loadEntry`, (_event, call: unknown) => {
    const modulePath = (call as { modulePath?: unknown } | null)?.modulePath;
    return loadPluginEntry(requireString(modulePath, 'modulePath'));
  });
}
