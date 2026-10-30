/**
 * Workspace window entry point.
 * The launcher opens this page in its own window and delivers one handoff payload through the
 * receiver below. The window builds the main app from the payload: it reopens the storage backend,
 * starts the chat context, and drains its child windows on close.
 */

import { forceCloseWindow, onWindowEvent, resizeWindowResizable } from '../shared/nw.js';
import type { WorkspaceSettings } from '../shared/workspace.js';
import type { StorageBackend } from '../storage/storage.js';
import { requireElement } from './dom.js';
import { readAppArguments } from './arguments.js';
import { MainApp } from './main-app.js';
import { McpClientManager } from './mcp-client/manager.js';
import { mcpHostConfigFromProcess, startMcpHost, type McpHostHandle } from './mcp-host.js';
import {
  MAIN_HANDOFF_RECEIVER_NAME,
  isMainHandoffPayload,
  type MainHandoffCallbacks,
  type MainHandoffPayload,
  type MainHandoffReceiver,
} from './main-handoff.js';
import { NotificationHub } from './notification-hub.js';
import { PermissionGate } from './permission-gate.js';
import { PluginManager } from '../plugins.js';
import { registerBuiltinStorageSetups } from './storage-setups.js';
import { StorageShareRegistry } from './storage-shares.js';
import { WorkspaceSettingsStore } from './settings-store.js';
import { initializeTheme } from './theme.js';
import { rememberMainWindowGeometry, restoreMainWindowGeometry } from './window-geometry.js';
import { ChildWindowManager } from './window-manager.js';

/** The size the workspace window takes when no stored geometry restores. */
const MAIN_WINDOW_SIZE = { width: 760, height: 680 } as const;

/** The plugin registry of the workspace window, seeded with the built-in storage setups. */
const plugins = new PluginManager();
registerBuiltinStorageSetups(plugins);

/** The app arguments, read once at startup. */
const appArguments = readAppArguments();

/** Reads the display label of the storage a workspace uses. */
function storageLabelFor(settings: WorkspaceSettings): string {
  return plugins.getStorageSetup(settings.storageId)?.label ?? settings.storageId;
}

/**
 * Starts the main app from one validated handoff payload.
 *
 * @param payload The handoff payload from the launcher.
 * @throws Error when the storage setup is not registered or the backend does not open.
 */
async function startWorkspaceApp(payload: MainHandoffPayload): Promise<void> {
  const { directory, settings, password } = payload;
  document.body.classList.toggle('framed', payload.frameMode === 'system');
  document.title = `${settings.name} — NodeWavenUI`;
  requireElement<HTMLElement>('#screen-main').hidden = false;
  // The workspace window reopens where the user left it, and falls back to the default size.
  if (!restoreMainWindowGeometry()) {
    resizeWindowResizable(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height);
  }
  rememberMainWindowGeometry();
  const setup = plugins.getStorageSetup(settings.storageId);
  if (setup === undefined) {
    throw new Error(`The storage "${settings.storageId}" of this workspace is not registered.`);
  }
  const backend: StorageBackend = setup.open(
    password !== null
      ? { directoryPath: directory.path, config: settings.storageConfig, password }
      : { directoryPath: directory.path, config: settings.storageConfig },
  );
  const store = new WorkspaceSettingsStore(backend);
  const permissionGate = new PermissionGate(store);
  const childWindows = new ChildWindowManager(permissionGate);
  // Child windows without an explicit frame argument inherit the frame of this window.
  childWindows.setDefaultFrame(payload.frameMode === 'system');
  const notificationHub = new NotificationHub();
  const mcpClients = new McpClientManager(notificationHub);
  const storageShares = new StorageShareRegistry(backend, (setupId) => plugins.getStorageSetup(setupId), directory.path);
  // The page API mounts on the workspace window and rides into every child window, so evaluated code
  // reaches the MCP endpoints from both.
  childWindows.setPageGlobalsProvider(() => mcpClients.pageApi);
  (globalThis as { nodewavenMcp?: unknown }).nodewavenMcp = mcpClients.pageApi;
  if (appArguments.exposeMainWindow) {
    console.warn(
      '[NodeWavenUI] DANGER: --expose-main-window is active. The workspace window is trackable like a child window.',
    );
    console.warn(
      '[NodeWavenUI] An agent that breaks the chat page can brick the app. A manual restart is then required, and the process may have to be killed.',
    );
    childWindows.exposeMainWindow();
  }
  const app = new MainApp(
    settings,
    store,
    storageLabelFor(settings),
    permissionGate,
    childWindows,
    mcpClients,
    notificationHub,
    directory.path,
    storageShares,
    plugins.listStorageSetups(),
  );
  // The workspace window closes only after every child window closed: NW.js keeps the process alive while
  // any window stays open, so a surviving child would wedge the app and the restart loop. NW.js fires
  // the close event without closing until the callback closes again, which gives the drain its window.
  let drainingChildren = false;
  onWindowEvent('close', () => {
    if (drainingChildren) {
      return;
    }
    drainingChildren = true;
    void childWindows
      .closeAllChildren({ principal: 'user' })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the child windows did not all close: ${message}`);
      })
      .then(() => {
        forceCloseWindow();
      });
  });
  // The argument --mcp-host=<port>[:<interface>] turns the debug MCP host on for external agents.
  // The app is the session sink, so every MCP session gets its chat tab.
  let mcpHost: McpHostHandle | null = null;
  try {
    const config = mcpHostConfigFromProcess();
    if (config !== null) {
      mcpHost = await startMcpHost(childWindows, config, store, app);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the MCP host could not start: ${message}`);
  }
  await app.start(mcpHost);
  console.info('[NodeWavenUI] main app ready');
}

/**
 * Receives the handoff payload from the launcher and reports the outcome.
 * The callbacks close over the launcher window, so each answer sits in a try/catch: the user can
 * close the launcher while the workspace window starts. A failed answer closes this window, so no
 * orphan stays open.
 */
const receiveHandoff: MainHandoffReceiver = (payload: unknown, callbacks: MainHandoffCallbacks): void => {
  if (!isMainHandoffPayload(payload)) {
    callbacks.onFailed('The workspace window received an invalid startup payload.');
    return;
  }
  void startWorkspaceApp(payload)
    .then(() => {
      try {
        callbacks.onReady();
      } catch {
        // The launcher is gone. The workspace window stands on its own.
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        callbacks.onFailed(message);
      } catch {
        forceCloseWindow();
      }
    });
};

(globalThis as unknown as Record<string, unknown>)[MAIN_HANDOFF_RECEIVER_NAME] = receiveHandoff;

initializeTheme();
// One global catch for rejected promises, so the stderr log carries every unhandled failure.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error(`[NodeWavenUI] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
console.info('[NodeWavenUI] workspace window ready for handoff');
