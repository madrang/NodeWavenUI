/**
 * The preload of every app window (launcher, wizard, workspace, child windows). It exposes the
 * `nodewavenui` bridge on the isolated world: the fs slice, the app facts, the native dialogs,
 * and the window calls, every one answered by the main process. Frame guests load their own
 * preload instead.
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'nodewavenui';

// The bridge serves app pages only: a remote page embedded as an iframe gets an inert preload.
if (window.location.protocol !== 'app:') {
  module.exports = {};
} else {

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
    toggleMaximize: () => ipcRenderer.invoke(`${CHANNEL}:windows:toggleMaximize`),
    toggleDevTools: () => ipcRenderer.invoke(`${CHANNEL}:windows:toggleDevTools`),
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
    allowProviderCors: (baseUrls) => ipcRenderer.invoke(`${CHANNEL}:cors:allowProviders`, baseUrls),
    readMcpResource: (uri) => ipcRenderer.invoke(`${CHANNEL}:mcp:readResource`, uri),
    runMcpNativeTool: (name, args) => ipcRenderer.invoke(`${CHANNEL}:mcp:runNativeTool`, { name, args }),
  },
  plugins: {
    loadEntry: (modulePath) => ipcRenderer.invoke(`${CHANNEL}:plugins:loadEntry`, { modulePath }),
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
