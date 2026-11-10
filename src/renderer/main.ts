/**
 * Workspace window entry point.
 * The main process opens this page in its own window and delivers one handoff payload over the
 * bridge. The window builds the main app from the payload: it reopens the storage backend,
 * starts the chat context, and serves the permission checks and MCP traffic of the main
 * services.
 */

import type { WorkspaceSettings } from '../shared/workspace.js';
import { readBridge, type BridgeMcpSinkEvent, type BridgePermissionCheck } from '../shared/bridge.js';
import type { StorageBackend } from '../storage/storage.js';
import { requireElement } from './dom.js';
import { ChatSessionStore } from './chat-sessions.js';
import { MainApp } from './main-app.js';
import { createMcpClientAdapter } from './mcp-client-adapter.js';
import type { McpHostHandle } from '../shared/window-tools.js';
import { isMainHandoffPayload, type MainHandoffPayload } from './main-handoff.js';
import { NotificationHub } from './notification-hub.js';
import { PermissionGate } from './permission-gate.js';
import { PluginManager } from './plugins.js';
import { registerBuiltinStorageSetups } from './storage-setups.js';
import { registerBuiltinSystemPromptSetups } from './system-prompts.js';
import { BUILT_IN_HARNESS_DOC_URIS, setPluginHarnessDocs } from './doc-resources.js';
import { readAppRootPath } from './node-context.js';
import { serveFrames } from './frames.js';
import { PluginFolderController, bridgePluginFolderFs } from './plugin-folders.js';
import { StorageShareRegistry } from './storage-shares.js';
import { WorkspaceSettingsStore } from './settings-store.js';
import { initializeTheme } from './theme.js';
import { rememberMainWindowGeometry, restoreMainWindowGeometry } from './window-geometry.js';
import { forceCloseWindow, resizeWindowResizable } from './window-ops.js';

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
  if (!(await restoreMainWindowGeometry())) {
    await resizeWindowResizable(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height);
  }
  rememberMainWindowGeometry();
  const setup = plugins.getStorageSetup(settings.storageId);
  if (!setup) {
    throw new Error(`The storage "${settings.storageId}" of this workspace is not registered.`);
  }
  const backend: StorageBackend = setup.open(
    password ?
      { directoryPath: directory.path, config: settings.storageConfig, password } :
      { directoryPath: directory.path, config: settings.storageConfig },
  );
  const store = new WorkspaceSettingsStore(backend);
  const permissionGate = new PermissionGate(store);
  const notificationHub = new NotificationHub();
  const mcpClients = createMcpClientAdapter();
  const storageShares = new StorageShareRegistry(
    backend,
    (setupId) => plugins.getStorageSetup(setupId),
    directory.path,
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
    new ChatSessionStore(directory.path, store, setup.needsPassword),
    plugins.listSystemPromptSetups(),
    pluginFolders,
  );
  const bridge = readBridge();
  if (!bridge) {
    throw new Error('The workspace window runs outside the app, so no service can reach it.');
  }
  // The main services ask this page for permission decisions: the same gate the chat uses,
  // with the same cards and rules.
  bridge.workspace.onPermissionRequest(async (check: BridgePermissionCheck) => {
    console.info(`[NodeWavenUI] permission check: ${check.principal} ${check.action}`);
    try {
      await permissionGate.check(
        check.principal as Parameters<typeof permissionGate.check>[0],
        check.action,
        check.target as Parameters<typeof permissionGate.check>[2],
        check.description,
        check.source,
        check.preauthorized,
      );
      console.info(`[NodeWavenUI] permission check: ${check.principal} ${check.action} allowed`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.info(`[NodeWavenUI] permission check: ${check.principal} ${check.action} refused: ${message}`);
      return { ok: false, error: message };
    }
  });
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
  console.info('[NodeWavenUI] main app ready');
}

/** Routes one MCP host sink event of the main process into the host tab of the app. */
function dispatchSinkEvent(app: MainApp, event: BridgeMcpSinkEvent): void {
  if (event.kind === 'sessionOpened') {
    app.sessionOpened('', event.info as Parameters<MainApp['sessionOpened']>[1]);
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
    console.error('[NodeWavenUI] the workspace window received an invalid startup payload.');
    void forceCloseWindow();
    return;
  }
  void startWorkspaceApp(payload).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[NodeWavenUI] the workspace window failed to start: ${message}`);
    void forceCloseWindow();
  });
}

// One global catch for rejected promises, so the stderr log carries every unhandled failure.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error(`[NodeWavenUI] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

/** Boots the workspace window: the theme, then the handoff payload. */
async function boot(): Promise<void> {
  await initializeTheme();
  const bridge = readBridge();
  if (!bridge) {
    console.error('[NodeWavenUI] the workspace window runs outside the app, so no handoff can arrive.');
    return;
  }
  console.info('[NodeWavenUI] workspace window ready for handoff');
  receiveHandoff(await bridge.windows.takeHandoff());
}

void boot();
