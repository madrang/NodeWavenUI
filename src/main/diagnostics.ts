/**
 * The renderer console relay: warnings and errors always reach the main log, and `--verbose`
 * mirrors every line, so the sandboxed pages stay observable during development. Every line
 * lands in the logging hierarchy under a child named after the window label.
 */

import { type BrowserWindow } from 'electron';
import { log } from './logger.js';

/** True when the app started with `--verbose`, which mirrors every renderer console line. */
const verbose = process.argv.includes('--verbose');

/** Logs the renderer console of one window: warnings and errors always, every line under `--verbose`. */
export function relayRendererConsole(win: BrowserWindow, label: string): void {
  const relay = log.renderer[label];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      relay.error(event.message);
      return;
    }
    if (event.level === 'warning') {
      relay.warning(event.message);
      return;
    }
    if (verbose) {
      relay.informative(event.message);
    }
  });
  win.webContents.on('did-finish-load', () => {
    relay.informative('loaded: %s', win.webContents.getTitle());
  });
  win.webContents.on('did-fail-load', (_event, code: number, description: string, url: string) => {
    relay.error('failed to load %s: %s %s', url, code, description);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    relay.critical('renderer gone: %s', details.reason);
  });
}
