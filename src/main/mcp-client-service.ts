/**
 * The MCP client service of the main process: it owns the endpoint connections, their native
 * tools, and the page API. The workspace page drives it through the bridge — endpoint configs
 * arrive from its storage, state changes and notifications flow back as pushes.
 */

import { ipcMain } from 'electron';
import type { McpEndpoints } from '../shared/mcp-endpoints.js';
import { asRecord } from '../shared/records.js';
import { McpClientManager } from './mcp-manager.js';
import { callWorkspace, pushWorkspace, workspaceContents } from './workspace-link.js';

/** The ipc channel prefix every bridge call shares. */
const CHANNEL = 'nodewavenui';

/** One local listener of the page API notification registry. The registry lives here, because
 * listener functions never cross the bridge. */
interface LocalListener {
  id: number;
  name: string;
  listener: (heard: unknown, params: unknown, source: string) => unknown;
}

const localListeners = new Map<number, LocalListener>();
let nextListenerId = 1;

/** The one client manager of the app. Notifications ride into the workspace chat. */
const manager = new McpClientManager({
  notify: (...parts: readonly unknown[]) => {
    pushWorkspace('mcp.notification', parts);
  },
  dispatch: (method: string, params: unknown, source: string) => {
    pushWorkspace('mcp.dispatch', { method, params, source });
    for (const entry of localListeners.values()) {
      if (entry.name === method || entry.name === '*') {
        entry.listener(true, params, source);
      }
    }
  },
  subscribe: (name: string, listener: (heard: unknown, params: unknown, source: string) => unknown): number => {
    const id = nextListenerId;
    nextListenerId += 1;
    localListeners.set(id, { id, name, listener });
    return id;
  },
  unsubscribe: (id: number): void => {
    localListeners.delete(id);
  },
});

/** True once the service registered its handlers. */
let registered = false;

/** Installs the bridge handlers of the client service. Idempotent. */
export function registerMcpClientService(): void {
  if (registered) {
    return;
  }
  registered = true;
  ipcMain.handle(`${CHANNEL}:mcp:invoke`, async (_event, call: unknown) => {
    const candidate = call as { method?: unknown; args?: unknown } | null;
    const api = manager.pageApi;
    const method = typeof candidate?.method === 'string' ? api[candidate.method] : undefined;
    if (typeof method !== 'function') {
      throw new Error(`The page API serves no method "${String(candidate?.method)}".`);
    }
    return method(...(Array.isArray(candidate?.args) ? candidate.args : []));
  });
  ipcMain.handle(`${CHANNEL}:mcp:runNativeTool`, async (_event, call: unknown) => {
    const candidate = call as { name?: unknown; args?: unknown } | null;
    if (typeof candidate?.name !== 'string') {
      throw new Error('The native tool call needs a name string.');
    }
    const args = asRecord(candidate.args) ?? {};
    return manager.runNativeTool(candidate.name, args);
  });
  ipcMain.handle(`${CHANNEL}:mcp:readResource`, (_event, uri: unknown) => {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error('The resource read needs a uri string.');
    }
    return manager.readResource(uri);
  });
  ipcMain.handle(`${CHANNEL}:mcp:applyEndpoints`, (_event, endpoints: unknown) => {
    return applyEndpoints(endpoints);
  });
  manager.subscribe(() => {
    pushWorkspace('mcp.state', { servers: manager.listServers(), nativeTools: manager.nativeTools() });
  });
}

/**
 * Applies one endpoint list from the workspace page.
 *
 * @param endpoints The endpoint list of the settings store.
 */
async function applyEndpoints(endpoints: unknown): Promise<void> {
  await manager.applyEndpoints(endpoints as McpEndpoints);
  pushWorkspace('mcp.state', { servers: manager.listServers(), nativeTools: manager.nativeTools() });
}

/** Loads the endpoint list from the workspace storage and applies it. Runs once a workspace opens. */
export async function startMcpClientService(): Promise<void> {
  registerMcpClientService();
  if (!workspaceContents()) {
    return;
  }
  try {
    await applyEndpoints(await callWorkspace<McpEndpoints>('mcp.endpoints.load', null));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the MCP endpoints could not load: ${message}`);
  }
}
