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
import { startWorkspaceWorker, stopWorkspaceWorker, coreRequest } from './worker-service.js';
import { ensureTray, removeTray, trayActive } from './tray.js';

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
  ipcMain.handle(`${CHANNEL}:windows:toggleMaximize`, (event) => {
    const win = windowOf(event.sender);
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
      return;
    }
    win.maximize();
  });
  ipcMain.handle(`${CHANNEL}:windows:openDevTools`, (event) => {
    const contents = event.sender;
    if (!contents.isDevToolsOpened()) {
      contents.openDevTools();
    }
  });
  ipcMain.handle(`${CHANNEL}:windows:toggleDevTools`, (event) => {
    const contents = event.sender;
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
      return;
    }
    contents.openDevTools();
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
    if (
      !win ||
      (name !== 'close' && name !== 'moved' && name !== 'resized' && name !== 'maximize' && name !== 'unmaximize')
    ) {
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
    if (name === 'maximize' || name === 'unmaximize') {
      // A restore fires no resize on every platform, so the two states push on their own events.
      const pushState = (): void => {
        push();
      };
      if (name === 'maximize') {
        win.on('maximize', pushState);
      } else {
        win.on('unmaximize', pushState);
      }
      event.sender.once('destroyed', () => {
        win.removeAllListeners('maximize');
        win.removeAllListeners('unmaximize');
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
      // The borderless workspace owns its corners: the window stays transparent and square, the
      // page rounds its screen, and a maximized screen squares so no gap sits at the edges.
      ...(!frame ? { transparent: true, roundedCorners: false } : {}),
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
    // The background core opens the workspace storage while the window loads: the renderers of
    // this workspace reach it through the core slice of the bridge, never through a local backend.
    const launch = handoff as {
      directory: { path: string };
      settings?: { name?: unknown; storageId?: unknown; storageConfig?: unknown };
      password?: unknown;
    };
    startWorkspaceWorker({
      directoryPath: launch.directory.path,
      name: typeof launch.settings?.name === 'string' ? launch.settings.name : '',
      storageId: typeof launch.settings?.storageId === 'string' ? launch.settings.storageId : '',
      storageConfig: launch.settings?.storageConfig,
      password: typeof launch.password === 'string' ? launch.password : null,
      appRoot: APP_ROOT,
    });
    // The workspace window closes only after every child closed: a surviving child would hold
    // the process alive and stall the launch loop. The close event is held once for the drain,
    // then the close behavior decides: quit destroys the window, tray hides it and keeps the
    // worker core, the MCP host, and the remote control alive.
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
        .then(async () => {
          let behavior: 'quit' | 'tray' = 'quit';
          try {
            const stored = await coreRequest('settings.get', { key: 'close-behavior' });
            behavior = stored === 'tray' ? 'tray' : 'quit';
          } catch {
            // No worker, no record: quit stays the default.
          }
          if (behavior === 'tray') {
            ensureTray(() => {
              win.show();
              win.focus();
            });
            win.hide();
            // The window stays alive hidden, so its next close drains the children again.
            drainingChildren = false;
            return;
          }
          if (trayActive()) {
            // A headless start owns the tray; a quitting window leaves it in place.
            return;
          }
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
      stopWorkspaceWorker();
      // A real close quits the window path, so its tray goes with it. A headless start keeps its own.
      if (!process.argv.includes('--headless')) {
        removeTray();
      }
    });
    void win.loadURL(rendererUrl('main.html'));
  });
}
