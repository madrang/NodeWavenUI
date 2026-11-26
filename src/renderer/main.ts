/**
 * Workspace window entry point.
 * The main process opens this page in its own window and delivers one handoff payload over the
 * bridge. The window builds the main app from the payload: it opens the storage the worker core
 * holds, starts the chat screen over the chats the core owns, and serves the frames the main
 * services build.
 */

import type { WorkspaceSettings } from '../shared/workspace.js';
import { readBridge, type BridgeMcpSinkEvent } from '../shared/bridge.js';
import type { StorageBackend } from '../storage/storage.js';
import { requireElement } from './dom.js';
import { MainApp } from './main-app.js';
import { createMcpClientAdapter } from './mcp-client-adapter.js';
import type { McpHostHandle } from '../shared/window-tools.js';
import { isMainHandoffPayload, type MainHandoffPayload } from './main-handoff.js';
import { NotificationHub } from './notification-hub.js';
import { PermissionGate } from './permission-gate.js';
import { PluginManager } from './plugins.js';
import { registerBuiltinStorageSetups } from './storage-setups.js';
import { registerBuiltinSystemPromptSetups } from './system-prompts.js';
import { BUILT_IN_HARNESS_DOC_URIS, setPluginHarnessDocs } from '../shared/harness-docs.js';
import { readAppRootPath } from './node-context.js';
import { serveFrames } from './frames.js';
import { log } from './logger.js';
import { init as initLanguage, LANGUAGE_MIRROR_KEY, localizeHTML } from './locale/index.js';
import { PluginFolderController, bridgePluginFolderFs } from './plugin-folders.js';
import { openCoreStorage } from './remote-storage.js';
import { StorageShareRegistry } from '../storage/share-registry.js';
import { WorkspaceSettingsStore } from '../storage/settings-store.js';
import { initializeTheme } from './theme.js';
import { rememberMainWindowGeometry, restoreMainWindowGeometry } from './window-geometry.js';
import { forceCloseWindow, onWindowEvent, resizeWindowResizable } from './window-ops.js';
import { writeWorkspaceMarker } from './workspace-files.js';
import { mountChatView } from './views/chat/view.js';
import { mountSettingsView } from './views/settings/view.js';

/** The size the workspace window takes when no stored geometry restores. */
const MAIN_WINDOW_SIZE = { width: 760, height: 680 } as const;

/** The plugin registry of the workspace window, seeded with the built-in storage and system prompt setups.
 * The built-in harness document uris come reserved, so a plugin document never shadows one. */
const plugins = new PluginManager(BUILT_IN_HARNESS_DOC_URIS);
registerBuiltinStorageSetups(plugins);
registerBuiltinSystemPromptSetups(plugins);

/** Reads the display label of the storage a workspace uses. */
function storageLabelFor(settings: WorkspaceSettings): string {
  return plugins.getStorageSetup(settings.storageId)?.label ?? settings.storageId;
}

/**
 * Stamps the workspace marker with the version the launcher stage chose. The core reported ready, so
 * every step of the data format migration ran. A failed write logs a warning, and the workspace opens:
 * the marker then keeps its loaded version, and the steps run again at the next open.
 *
 * @param payload The handoff payload from the launcher.
 */
async function stampWorkspaceMarker(payload: MainHandoffPayload): Promise<void> {
  if (!payload.stampVersion) {
    return;
  }
  const writeError = await writeWorkspaceMarker(payload.directory.path, {
    ...payload.settings,
    version: payload.stampVersion,
  });
  if (writeError) {
    log.main.warning(`the migrated marker could not be written: ${writeError}`);
  }
}

/**
 * Starts the main app from one validated handoff payload.
 *
 * @param payload The handoff payload from the launcher.
 * @throws Error when the storage setup is not registered or the backend does not open.
 */
async function startWorkspaceApp(payload: MainHandoffPayload): Promise<void> {
  const { directory, settings } = payload;
  document.body.classList.toggle('framed', payload.frameMode === 'system');
  // A maximized screen squares its corners, so no rounded gap sits at the screen edges. The
  // maximize states arrive as events, and the resize check covers the states the boot missed.
  const setMaximizedCorners = (maximized: boolean): void => {
    document.body.classList.toggle('maximized', maximized);
  };
  const measureMaximized = (): void => {
    setMaximizedCorners(
      window.outerWidth >= window.screen.width - 2 && window.outerHeight >= window.screen.availHeight - 2,
    );
  };
  onWindowEvent('maximize', () => {
    setMaximizedCorners(true);
  });
  onWindowEvent('unmaximize', () => {
    setMaximizedCorners(false);
  });
  onWindowEvent('resized', measureMaximized);
  measureMaximized();
  document.title = `${settings.name} — NodeWavenUI`;
  requireElement<HTMLElement>('#screen-main').hidden = false;
  // The workspace window reopens where the user left it, and falls back to the default size.
  if (!(await restoreMainWindowGeometry())) {
    await resizeWindowResizable(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height);
  }
  rememberMainWindowGeometry();
  const setup = plugins.getStorageSetup(settings.storageId);
  if (!setup) {
    throw new Error(`The storage "${settings.storageId}" of this workspace is not registered.`);
  }
  const bridge = readBridge();
  if (!bridge) {
    throw new Error('The workspace window runs outside the app, so no service can reach it.');
  }
  // The storage of the workspace lives in the background core: the worker opens the settings
  // file while this window loads, and the page waits for its state before it reads anything.
  const backend: StorageBackend = await openCoreStorage(bridge);
  // The core reported ready, so every step of the data format migration ran. The marker takes the
  // running version now: until then it held the version it loaded with.
  await stampWorkspaceMarker(payload);
  const store = new WorkspaceSettingsStore(backend);
  // The gate state lives in the worker core too: this proxy carries the checks of the file tools
  // and the agent tools into it, and the cards render from its pushed state.
  const permissionGate = new PermissionGate(bridge);
  const notificationHub = new NotificationHub();
  const mcpClients = createMcpClientAdapter();
  const storageShares = new StorageShareRegistry(
    backend,
    (setupId) => plugins.getStorageSetup(setupId),
    directory.path,
    () => permissionGate.listRules(),
  );
  const pluginFolders = new PluginFolderController(
    plugins,
    { load: () => store.loadPluginFolders(), save: (record) => store.savePluginFolders(record) },
    (await readAppRootPath()) ?? '',
    bridgePluginFolderFs(),
  );
  await pluginFolders.initialize();
  // The plugin documents join the harness list only while their plugin loaded, so a removed
  // plugin folder leaves no dangling resource behind.
  setPluginHarnessDocs(plugins.listHarnessDocs());
  // The chats live in the worker core: its engine runs the turns, and the app screen renders the
  // state it pushes.
  const app = new MainApp(
    settings,
    store,
    storageLabelFor(settings),
    permissionGate,
    mcpClients,
    notificationHub,
    directory.path,
    storageShares,
    plugins.listStorageSetups(),
    plugins.listSystemPromptSetups(),
    pluginFolders,
  );
  // One request router serves every channel the main process calls: the token storage, the
  // page API proxies, and the frame builds. One registration answers, so no channel races.
  const workspaceRoutes = new Map<string, (payload: unknown) => Promise<unknown>>();
  const route = (channel: string, handler: (payload: unknown) => Promise<unknown>): void => {
    workspaceRoutes.set(channel, handler);
  };
  route('mcp.token.load', async () => store.loadMcpHostToken());
  route('mcp.token.save', async (payload) => {
    await store.saveMcpHostToken(typeof payload === 'string' ? payload : '');
    return null;
  });
  route('mcp.endpoints.load', async () => store.loadMcpEndpoints());
  // The frame panels build here, and the frame commands of the main process land here.
  await serveFrames(route);
  bridge.workspace.onWorkspaceRequest(async (channel: string, payload: unknown) => {
    const handler = workspaceRoutes.get(channel);
    if (!handler) {
      throw new Error(`The workspace serves no channel "${channel}".`);
    }
    return handler(payload);
  });
  // The notifications of the MCP connections of the main process reach the chat, and their
  // dispatches route into the hub, so the notification lists stay live.
  bridge.workspace.onWorkspaceEvent('mcp.notification', (payload) => {
    notificationHub.notifyChat(...(Array.isArray(payload) ? (payload as readonly unknown[]) : []));
  });
  bridge.workspace.onWorkspaceEvent('mcp.dispatch', (payload) => {
    const dispatch = payload as { method?: unknown; params?: unknown; source?: unknown } | null;
    if (typeof dispatch?.method === 'string') {
      notificationHub.dispatch(dispatch.method, dispatch.params, typeof dispatch.source === 'string' ? dispatch.source : 'mcp');
    }
  });
  // Every MCP session and tool call of the host lands in the host tab.
  bridge.workspace.onWorkspaceEvent('mcp.sink', (payload) => {
    dispatchSinkEvent(app, payload as BridgeMcpSinkEvent);
  });
  // The MCP host starts once this storage is open. The handle carries the endpoint for the settings pane.
  const endpoint = await bridge.workspace.startMcpHost();
  let hostToken = '';
  const mcpHost: McpHostHandle | null =
    endpoint ?
      {
        endpoint,
        readAccessToken: () => hostToken,
      } :
      null;
  if (endpoint) {
    void bridge.workspace.mcpHostInfo().then((info) => {
      hostToken = info?.token ?? '';
    });
  }
  await app.start(mcpHost);
  log.main.informative('main app ready');
}

/** Routes one MCP host sink event of the main process into the host tab of the app. */
function dispatchSinkEvent(app: MainApp, event: BridgeMcpSinkEvent): void {
  if (event.kind === 'sessionOpened') {
    app.sessionOpened(event.sessionId, event.info as Parameters<MainApp['sessionOpened']>[1]);
    return;
  }
  if (event.kind === 'toolCall') {
    app.toolCall(event.sessionId, event.toolName, (event.args ?? {}) as Record<string, unknown>);
    return;
  }
  if (event.kind === 'toolResult') {
    app.toolResult(event.sessionId, event.toolName, event.summary, event.isError, event.json, event.images as never);
    return;
  }
  app.clientNotification(event.sessionId, event.method, event.params);
}

/**
 * Receives the handoff payload from the main process and starts the app.
 * A failed start closes this window, so no orphan stays open: the launcher already closed when
 * the window opened.
 */
function receiveHandoff(payload: unknown): void {
  if (!isMainHandoffPayload(payload)) {
    log.main.error('the workspace window received an invalid startup payload.');
    void forceCloseWindow();
    return;
  }
  void startWorkspaceApp(payload).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.main.error(`the workspace window failed to start: ${message}`);
    void forceCloseWindow();
  });
}

// One global catch for rejected promises, so the stderr log carries every unhandled failure.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  log.main.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

/** Boots the workspace window: the theme, the language, the views, then the handoff payload. */
async function boot(): Promise<void> {
  await initializeTheme();
  initLanguage(localStorage.getItem(LANGUAGE_MIRROR_KEY));
  await Promise.all([mountSettingsView(), mountChatView()]);
  localizeHTML(document.documentElement);
  const bridge = readBridge();
  if (!bridge) {
    log.main.error('the workspace window runs outside the app, so no handoff can arrive.');
    return;
  }
  log.main.informative('workspace window ready for handoff');
  receiveHandoff(await bridge.windows.takeHandoff());
}

void boot();
