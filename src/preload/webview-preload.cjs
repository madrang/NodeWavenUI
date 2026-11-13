/**
 * The preload of every webview frame guest. A sandboxed preload cannot require files, so this
 * file carries the app bridge inline and mirrors `app-preload.cjs`: keep the two in sync. Every
 * guest announces itself to the main process with the frame token of its address, which binds
 * the guest to its frame record whatever origin it loads. An app-origin guest also receives the
 * bridge and the page API; a guest on any other origin stays without them.
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'nodewavenui';

// The token announcement runs for every origin: the attach of a remote frame needs the binding
// too, and the code sits in the preload context, out of reach of the page.
const guestToken = new URLSearchParams(window.location.search).get('nvframe');
if (guestToken !== null) {
  ipcRenderer.send('nodewavenui:frames:guest', { token: Number(guestToken) });
}

// The bridge serves app pages only: a remote page embedded as a webview gets no bridge.
if (window.location.protocol === 'app:') {

const bridge = {
  fs: {
    list: (directory) => ipcRenderer.invoke(`${CHANNEL}:fs:list`, directory),
    readText: (path) => ipcRenderer.invoke(`${CHANNEL}:fs:readText`, path),
    readData: (path) => ipcRenderer.invoke(`${CHANNEL}:fs:readData`, path),
    writeText: (path, text) => ipcRenderer.invoke(`${CHANNEL}:fs:writeText`, path, text),
    writeData: (path, data) => ipcRenderer.invoke(`${CHANNEL}:fs:writeData`, path, data),
    makeDirectory: (path) => ipcRenderer.invoke(`${CHANNEL}:fs:makeDirectory`, path),
    remove: (path) => ipcRenderer.invoke(`${CHANNEL}:fs:remove`, path),
    rename: (from, to) => ipcRenderer.invoke(`${CHANNEL}:fs:rename`, from, to),
    stat: (path) => ipcRenderer.invoke(`${CHANNEL}:fs:stat`, path),
  },
  app: {
    version: () => ipcRenderer.invoke(`${CHANNEL}:app:version`),
    arguments: () => ipcRenderer.invoke(`${CHANNEL}:app:arguments`),
    appRoot: () => ipcRenderer.invoke(`${CHANNEL}:app:appRoot`),
    platform: () => ipcRenderer.invoke(`${CHANNEL}:app:platform`),
    pickDirectory: (title) => ipcRenderer.invoke(`${CHANNEL}:app:pickDirectory`, title),
  },
  windows: {
    resizeLocked: (width, height) => ipcRenderer.invoke(`${CHANNEL}:windows:resizeLocked`, width, height),
    resizeResizable: (width, height) => ipcRenderer.invoke(`${CHANNEL}:windows:resizeResizable`, width, height),
    placement: () => ipcRenderer.invoke(`${CHANNEL}:windows:placement`),
    setBounds: (x, y, width, height) => ipcRenderer.invoke(`${CHANNEL}:windows:setBounds`, { x, y, width, height }),
    move: (x, y) => ipcRenderer.invoke(`${CHANNEL}:windows:move`, x, y),
    minimize: () => ipcRenderer.invoke(`${CHANNEL}:windows:minimize`),
    close: () => ipcRenderer.invoke(`${CHANNEL}:windows:close`),
    forceClose: () => ipcRenderer.invoke(`${CHANNEL}:windows:forceClose`),
    on: (event, listener) => {
      const reply = `${CHANNEL}:window:${event}`;
      ipcRenderer.on(reply, listener);
      ipcRenderer.send(`${CHANNEL}:windows:subscribe`, event);
      return () => ipcRenderer.removeListener(reply, listener);
    },
    takeHandoff: () => ipcRenderer.invoke(`${CHANNEL}:windows:takeHandoff`),
    openWorkspace: (handoff) => ipcRenderer.invoke(`${CHANNEL}:windows:openWorkspace`, handoff),
  },
  workspace: {
    runWindowTool: (name, args) => ipcRenderer.invoke(`${CHANNEL}:tools:call`, { name, args }),
    onPermissionRequest: (handler) => {
      ipcRenderer.on(`${CHANNEL}:workspace:request`, (_event, request) => {
        if (request && request.channel === 'permission.check') {
          void Promise.resolve(handler(request.payload)).then(
            (answer) => ipcRenderer.send(`${CHANNEL}:workspace:reply`, { id: request.id, ok: true, value: answer }),
            (error) => ipcRenderer.send(`${CHANNEL}:workspace:reply`, { id: request.id, ok: false, error: String(error) }),
          );
        }
      });
    },
    onWorkspaceRequest: (handler) => {
      ipcRenderer.on(`${CHANNEL}:workspace:request`, (_event, request) => {
        if (request && request.channel !== 'permission.check') {
          void Promise.resolve(handler(request.channel, request.payload)).then(
            (value) => ipcRenderer.send(`${CHANNEL}:workspace:reply`, { id: request.id, ok: true, value }),
            (error) => ipcRenderer.send(`${CHANNEL}:workspace:reply`, { id: request.id, ok: false, error: String(error) }),
          );
        }
      });
    },
    onWorkspaceEvent: (channel, listener) => {
      ipcRenderer.on(`${CHANNEL}:workspace:event`, (_event, event) => {
        if (event && event.channel === channel) {
          listener(event.payload);
        }
      });
    },
    startMcpHost: () => ipcRenderer.invoke(`${CHANNEL}:mcp:start`),
    mcpHostInfo: () => ipcRenderer.invoke(`${CHANNEL}:mcp:info`),
    notifyFrameShared: (id, shared) => ipcRenderer.invoke(`${CHANNEL}:frames:share`, { id, shared }),
    closeFrameAsUser: (id) => ipcRenderer.invoke(`${CHANNEL}:frames:closeUser`, { id }),
    applyMcpEndpoints: (endpoints) => ipcRenderer.invoke(`${CHANNEL}:mcp:applyEndpoints`, endpoints),
    readMcpResource: (uri) => ipcRenderer.invoke(`${CHANNEL}:mcp:readResource`, uri),
    runMcpNativeTool: (name, args) => ipcRenderer.invoke(`${CHANNEL}:mcp:runNativeTool`, { name, args }),
  },
};

contextBridge.exposeInMainWorld('nodewavenui', bridge);

// The nodewavenMcp page API rides as an ipc proxy: every page, the workspace included, calls
// through to the manager of the main process.
const pageApiMethods = ['list', 'call', 'enable', 'disable', 'resources', 'read', 'notify'];
const pageApiProxy = {};
for (const method of pageApiMethods) {
  pageApiProxy[method] = (...args) => ipcRenderer.invoke(`${CHANNEL}:mcp:invoke`, { method, args });
}
contextBridge.exposeInMainWorld('nodewavenMcp', pageApiProxy);
}
