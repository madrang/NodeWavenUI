/**
 * The MCP client adapter of the workspace page. The connections live in the main process;
 * this adapter keeps the surface the app UI and the chat agent use — endpoint applies, the
 * cached server states, and the native tool calls — over the bridge.
 */

import { readBridge } from '../shared/bridge.js';
import type { McpCallResult, McpEndpoints, McpNativeTool, McpServerState } from '../shared/mcp-endpoints.js';

/** The surface the app UI and the chat agent drive the MCP client through. */
export interface McpClientSurface {
  /** Applies one endpoint list: new endpoints connect per their mode, removed ones disconnect. */
  applyEndpoints(endpoints: McpEndpoints): Promise<void>;
  /** Reads the cached server states. The state push of the main process refreshes them. */
  listServers(): readonly McpServerState[];
  /** Subscribes to connection changes. The reply stops the subscription. */
  subscribe(listener: () => void): () => void;
  /** Reads one resource of the server that lists it. */
  readResource(uri: string): Promise<string>;
  /** Reads the cached native tool descriptors of the connected endpoints. */
  nativeTools(): readonly McpNativeTool[];
  /** Runs one native tool. */
  runNativeTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/**
 * Builds the MCP client adapter over the bridge.
 *
 * @returns The adapter, or a dead adapter outside an app window.
 */
export function createMcpClientAdapter(): McpClientSurface {
  let servers: readonly McpServerState[] = [];
  let native: readonly McpNativeTool[] = [];
  const listeners = new Set<() => void>();
  const bridge = readBridge();
  if (bridge) {
    bridge.workspace.onWorkspaceEvent('mcp.state', (payload) => {
      const state = payload as { servers?: unknown; nativeTools?: unknown } | null;
      servers = Array.isArray(state?.servers) ? (state.servers as readonly McpServerState[]) : [];
      native = Array.isArray(state?.nativeTools) ? (state.nativeTools as readonly McpNativeTool[]) : [];
      for (const listener of listeners) {
        listener();
      }
    });
  }
  return {
    applyEndpoints: async (endpoints) => {
      await readBridge()?.workspace.applyMcpEndpoints(endpoints as unknown);
    },
    listServers: () => servers,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readResource: (uri) => {
      const workspace = readBridge()?.workspace;
      if (!workspace) {
        return Promise.reject(new Error('The MCP client needs the nodewavenui bridge of an app window.'));
      }
      return workspace.readMcpResource(uri);
    },
    nativeTools: () => native,
    runNativeTool: (name, args) => {
      const workspace = readBridge()?.workspace;
      if (!workspace) {
        return Promise.reject(new Error('The MCP client needs the nodewavenui bridge of an app window.'));
      }
      return workspace.runMcpNativeTool(name, args) as Promise<McpCallResult>;
    },
  };
}
