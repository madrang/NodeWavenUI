/**
 * The Electron main process of NodeWavenUI. It owns the app:// protocol, the windows, and —
 * stage by stage of the port — every Node service the sandboxed renderers reach through the
 * preload bridge.
 */

import { app, BrowserWindow, ipcMain, session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_AGENT_SOURCE } from '../shared/permissions.js';
import { relayRendererConsole } from './diagnostics.js';
import { createTools, parseMcpHostArgument, readMcpHostInfo, startMcpHost } from './mcp-host.js';
import { registerAppProtocol, registerAppProtocolPrivileges, rendererUrl } from './protocol.js';
import { registerProviderCors } from './provider-cors.js';
import { registerServices } from './services.js';
import { registerMcpClientService } from './mcp-client-service.js';
import { sessions } from './session-service.js';
import { registerWindowService } from './window-service.js';
import { registerWorkspaceLink } from './workspace-link.js';

registerAppProtocolPrivileges();

/** The absolute path of the app root, one level above the compiled main directory. */
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Creates the launcher window: fixed-size, borderless, transparent. */
function createLauncherWindow(): void {
  const win = new BrowserWindow({
    width: 300,
    height: 120,
    center: true,
    frame: false,
    transparent: true,
    resizable: false,
    title: 'NodeWavenUI',
    icon: join(APP_ROOT, 'icons', 'icon-256.png'),
    webPreferences: {
      preload: join(APP_ROOT, 'src', 'preload', 'app-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  relayRendererConsole(win, 'launcher');
  void win.loadURL(rendererUrl('index.html'));
  runSmokeProbe(win);
}

/**
 * Runs the `--smoke=<probe>` check of one window: the probe reads the page, prints its answer
 * as one JSON line, and quits the app. It verifies a stage of the port without a live session.
 *
 * @param win The window the probe reads.
 */
function runSmokeProbe(win: BrowserWindow): void {
  const probe = process.argv.find((argument) => argument.startsWith('--smoke='))?.slice('--smoke='.length);
  if (!probe) {
    return;
  }
  const expressions: Record<string, string> = {
    launcher: '(() => ({ screen: !!document.querySelector(\'#screen-launcher\'), button: document.querySelector(\'#select-directory\')?.textContent ?? null, theme: document.documentElement.dataset.theme ?? null }))()',
    assets: '(async () => ({ index: await fetch(\'index.js\').then((r) => r.status + \' \' + (r.headers.get(\'content-type\') ?? \'no-type\')).catch((e) => \'fetch-error \' + String(e)), css: await fetch(\'styles.css\').then((r) => r.status + \' \' + (r.headers.get(\'content-type\') ?? \'no-type\')).catch((e) => \'fetch-error \' + String(e)) }))()',
    bridge: '(() => { console.info(\'[probe] relay-test\'); const bridge = globalThis.nodewavenui; if (!bridge) { return Promise.resolve(\'bridge missing\'); } return Promise.all([bridge.app.version(), bridge.app.appRoot(), bridge.fs.list(\'.\').catch((e) => \'list:\' + String(e))]).then((values) => ({ version: values[0], root: values[1], list: values[2] })); })()',
  };
  const expression = expressions[probe];
  if (!expression) {
    // Another probe of the app owns this name, for example the workspace probe of the window service.
    console.log(`[NodeWavenUI] smoke: the launcher knows no probe "${probe}", it stays for another handler.`);
    return;
  }
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(expression)
      .then((value) => {
        console.log(`[NodeWavenUI] smoke ${probe}: ${JSON.stringify(value)}`);
        app.quit();
      })
      .catch((error: unknown) => {
        console.log(`[NodeWavenUI] smoke ${probe} failed: ${String(error)}`);
        app.quit();
      });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

void app.whenReady().then(() => {
  registerAppProtocol();
  registerProviderCors(session.defaultSession);
  registerServices();
  registerMcpClientService();
  registerWindowService();
  registerWorkspaceLink();
  registerToolService();
  createLauncherWindow();
  console.log(`[NodeWavenUI] main ready: electron ${process.versions.electron}, node ${process.versions.node}`);
});

/** Installs the chat agent tool calls and the MCP host control of the workspace page. */
function registerToolService(): void {
  // The guest preload of one webview frame announces itself with the token of its address.
  ipcMain.on('nodewavenui:frames:guest', (event, message: unknown) => {
    const token = (message as { token?: unknown } | null)?.token;
    if (typeof token === 'number' && Number.isInteger(token)) {
      sessions.bindGuestContents(token, event.sender);
    }
  });
  // The share switch of one frame title bar gates every debug attach on its guest.
  ipcMain.handle('nodewavenui:frames:share', (_event, change: unknown) => {
    const candidate = change as { id?: unknown; shared?: unknown } | null;
    if (typeof candidate?.id === 'number' && typeof candidate.shared === 'boolean') {
      sessions.setFrameShared(candidate.id, candidate.shared);
    }
    return null;
  });
  // The close control of one frame panel acts as the user principal.
  ipcMain.handle('nodewavenui:frames:closeUser', (_event, call: unknown) => {
    const id = (call as { id?: unknown } | null)?.id;
    if (typeof id !== 'number') {
      throw new Error('The frame close needs a frame id.');
    }
    return sessions.closeChild({ principal: 'user' }, id);
  });
  ipcMain.handle('nodewavenui:tools:call', async (_event, call: unknown) => {
    const candidate = call as { name?: unknown; args?: unknown } | null;
    if (typeof candidate?.name !== 'string') {
      throw new Error('The tool call needs a name string.');
    }
    const tool = createTools().find((descriptor) => descriptor.name === candidate.name);
    if (!tool) {
      throw new Error(`The tool "${candidate.name}" is unknown.`);
    }
    const args = typeof candidate.args === 'object' && candidate.args !== null ? (candidate.args as Record<string, unknown>) : {};
    return tool.handler(args, { principal: 'agent', source: CHAT_AGENT_SOURCE });
  });
  ipcMain.handle('nodewavenui:mcp:start', async () => {
    try {
      const config = parseMcpHostArgument(process.argv);
      if (!config) {
        return null;
      }
      const host = await startMcpHost(config);
      return host.readEndpoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the MCP host could not start: ${message}`);
      return null;
    }
  });
  ipcMain.handle('nodewavenui:mcp:info', () => readMcpHostInfo());
}
