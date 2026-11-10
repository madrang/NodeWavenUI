/**
 * The renderer console relay: warnings and errors always reach the main log, and `--verbose`
 * mirrors every line, so the sandboxed pages stay observable during development.
 */

import { type BrowserWindow } from 'electron';

/** True when the app started with `--verbose`, which mirrors every renderer console line. */
const verbose = process.argv.includes('--verbose');

/** Logs the renderer console of one window: warnings and errors always, every line under `--verbose`. */
export function relayRendererConsole(win: BrowserWindow, label: string): void {
  win.webContents.on('console-message', (event) => {
    if (verbose || event.level === 'warning' || event.level === 'error') {
      console.log(`[NodeWavenUI] ${label}: ${event.message}`);
    }
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`[NodeWavenUI] ${label} loaded: ${win.webContents.getTitle()}`);
  });
  win.webContents.on('did-fail-load', (_event, code: number, description: string, url: string) => {
    console.log(`[NodeWavenUI] ${label} failed to load ${url}: ${code} ${description}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[NodeWavenUI] ${label} renderer gone: ${details.reason}`);
  });
}
