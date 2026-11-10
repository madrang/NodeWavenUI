/**
 * The window service of the main process. It serves the per-window bridge calls — size,
 * placement, close, and events — and opens the workspace window for the launcher handoff,
 * holding the payload in memory until the new window receives it.
 */

import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayRendererConsole } from './diagnostics.js';
import { rendererUrl } from './protocol.js';
import { startMcpClientService } from './mcp-client-service.js';
import { sessions } from './session-service.js';
import { setWorkspaceContents } from './workspace-link.js';

/** The ipc channel prefix every bridge call shares. */
const CHANNEL = 'nodewavenui';

/** The app root, one level above the compiled main directory. */
const APP_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, ''));

/** The size the workspace window opens with before geometry restores. */
const WORKSPACE_SIZE = { width: 760, height: 680 } as const;

/** The handoff payload of every workspace window that opened and not yet taken it, keyed by window id. */
const pendingHandoffs = new Map<number, unknown>();

/**
 * Reads the window a bridge call came from.
 *
 * @param sender The web contents of the calling page.
 * @returns The window, or null when the caller is no window of this app.
 */
function windowOf(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender);
}

/** Marks one window as draining on close: the close event is held once until the page agrees. */
const drainingWindows = new WeakSet<BrowserWindow>();

/** Installs the per-window bridge handlers. Runs once the app is ready. */
export function registerWindowService(): void {
  ipcMain.handle(`${CHANNEL}:windows:resizeLocked`, (event, width: unknown, height: unknown) => {
    const win = windowOf(event.sender);
    if (win) {
      win.setResizable(true);
      win.setContentSize(Number(width), Number(height));
      win.setResizable(false);
    }
  });
  ipcMain.handle(`${CHANNEL}:windows:resizeResizable`, (event, width: unknown, height: unknown) => {
    const win = windowOf(event.sender);
    if (win) {
      win.setResizable(true);
      win.setContentSize(Number(width), Number(height));
      win.setMinimumSize(200, 200);
    }
  });
  ipcMain.handle(`${CHANNEL}:windows:placement`, (event) => {
    const win = windowOf(event.sender);
    if (!win) {
      return null;
    }
    const [x = 0, y = 0] = win.getPosition();
    const [width = 0, height = 0] = win.getSize();
    return { x, y, width, height };
  });
  ipcMain.handle(`${CHANNEL}:windows:setBounds`, (event, call: unknown) => {
    const win = windowOf(event.sender);
    const bounds = call as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (
      !win ||
      typeof bounds?.x !== 'number' ||
      typeof bounds?.y !== 'number' ||
      typeof bounds?.width !== 'number' ||
      typeof bounds?.height !== 'number'
    ) {
      return;
    }
    // Outer bounds, so a saved placement restores exactly: the content size would drop the frame.
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  });
  ipcMain.handle(`${CHANNEL}:windows:move`, (event, x: unknown, y: unknown) => {
    windowOf(event.sender)?.setPosition(Number(x), Number(y));
  });
  ipcMain.handle(`${CHANNEL}:windows:minimize`, (event) => {
    windowOf(event.sender)?.minimize();
  });
  ipcMain.handle(`${CHANNEL}:windows:close`, (event) => {
    windowOf(event.sender)?.close();
  });
  ipcMain.handle(`${CHANNEL}:windows:forceClose`, (event) => {
    const win = windowOf(event.sender);
    if (win) {
      drainingWindows.delete(win);
      win.destroy();
    }
  });

  ipcMain.on(`${CHANNEL}:windows:subscribe`, (event, name: unknown) => {
    const win = windowOf(event.sender);
    if (!win || (name !== 'close' && name !== 'moved' && name !== 'resized')) {
      return;
    }
    const push = (): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`${CHANNEL}:window:${name}`);
      }
    };
    if (name === 'close') {
      drainingWindows.add(win);
      win.on('close', (closeEvent) => {
        // A draining window holds its close once: the page drains its children, then force-closes.
        if (drainingWindows.has(win)) {
          drainingWindows.delete(win);
          closeEvent.preventDefault();
        }
        push();
      });
      event.sender.once('destroyed', () => {
        win.removeAllListeners('close');
      });
      return;
    }
    if (name === 'moved') {
      win.on('moved', () => {
        push();
      });
      event.sender.once('destroyed', () => {
        win.removeAllListeners('moved');
      });
      return;
    }
    win.on('resize', () => {
      push();
    });
    event.sender.once('destroyed', () => {
      win.removeAllListeners('resize');
    });
  });

  ipcMain.handle(`${CHANNEL}:windows:takeHandoff`, (event) => {
    const win = windowOf(event.sender);
    if (!win) {
      return null;
    }
    const handoff = pendingHandoffs.get(win.id);
    pendingHandoffs.delete(win.id);
    return handoff ?? null;
  });

  ipcMain.handle(`${CHANNEL}:windows:openWorkspace`, (event, handoff: unknown) => {
    if (typeof (handoff as { directory?: { path?: unknown } } | null)?.directory?.path !== 'string') {
      throw new Error('The workspace handoff needs a directory with a path string.');
    }
    const frame = (handoff as { frameMode?: unknown }).frameMode !== 'borderless';
    const win = new BrowserWindow({
      width: WORKSPACE_SIZE.width,
      height: WORKSPACE_SIZE.height,
      frame,
      title: 'NodeWavenUI',
      icon: join(APP_ROOT, 'icons', 'icon-256.png'),
      webPreferences: {
        preload: join(APP_ROOT, 'src', 'preload', 'app-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        // The preload also runs in the iframes of the page, so an embedded frame reaches the
        // bridge. The preload itself stays inert on every non-app origin.
        nodeIntegrationInSubFrames: true,
      },
    });
    relayRendererConsole(win, 'workspace');
    setWorkspaceContents(win.webContents);
    void startMcpClientService();
    // The workspace window closes only after every child closed: a surviving child would hold
    // the process alive and stall the launch loop. The close event is held once for the drain.
    let drainingChildren = false;
    win.on('close', (closeEvent) => {
      if (drainingChildren) {
        return;
      }
      drainingChildren = true;
      closeEvent.preventDefault();
      void sessions
        .closeAllChildren({ principal: 'user' })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[NodeWavenUI] the child windows did not all close: ${message}`);
        })
        .then(() => {
          win.destroy();
        });
    });
    if (process.argv.includes('--expose-main-window')) {
      console.warn('[NodeWavenUI] DANGER: --expose-main-window is active. The workspace window is trackable like a child window.');
      sessions.exposeMainWindow(win.webContents);
    }
    pendingHandoffs.set(win.id, handoff);
    win.once('ready-to-show', () => {
      win.show();
    });
    win.webContents.once('did-finish-load', () => {
      if (process.argv.includes('--smoke=workspace')) {
        // The workspace smoke: after the boot settles, read the page state and quit.
        setTimeout(() => {
          void win.webContents
            .executeJavaScript(
              '(async () => ({ main: !document.querySelector(\'#screen-main\')?.hidden, title: document.title, chats: document.querySelectorAll(\'#chat-tab-list button\').length, mcp: await globalThis.nodewavenui?.workspace?.mcpHostInfo() }))()',
            )
            .then((value) => {
              console.log(`[NodeWavenUI] smoke workspace: ${JSON.stringify(value)}`);
              app.quit();
            })
            .catch((error: unknown) => {
              console.log(`[NodeWavenUI] smoke workspace failed: ${String(error)}`);
              app.quit();
            });
        }, 6000);
      }
    });
    win.on('closed', () => {
      pendingHandoffs.delete(win.id);
    });
    void win.loadURL(rendererUrl('main.html'));
  });
}
