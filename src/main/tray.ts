/**
 * The tray of the app: the icon that keeps the app alive while the workspace window stays
 * hidden. The tray menu shows the workspace again and quits the app. It exists only while the
 * tray close behavior or the headless flag runs the app without a visible window.
 */

import { app, Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The app root, one level above the compiled main directory. */
const APP_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, ''));

/** The one tray of the app. Null while no surface needs it. */
let tray: Tray | null = null;

/**
 * Installs the tray when none exists.
 *
 * @param showWorkspace Shows the workspace window again.
 */
export function ensureTray(showWorkspace: () => void): void {
  if (tray) {
    return;
  }
  const icon = nativeImage.createFromPath(join(APP_ROOT, 'icons', 'icon-256.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('NodeWavenUI');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show workspace', click: () => {
        showWorkspace();
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => {
        app.quit();
      } },
    ]),
  );
}

/** Removes the tray, on quit or when the close behavior leaves the tray mode. */
export function removeTray(): void {
  tray?.destroy();
  tray = null;
}

/** True while the tray holds the app alive. */
export function trayActive(): boolean {
  return tray !== null;
}
