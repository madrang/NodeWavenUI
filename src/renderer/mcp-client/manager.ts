/**
 * The MCP client manager: it applies the configured endpoints, owns the server connections,
 * and builds the `nodewavenMcp` page API that evaluated code reaches from the main window and child windows.
 * The `native` mode surfaces its tools to the chat agent, prefixed with the sanitized endpoint label and a dot.
 */

import { sanitizeEndpointLabel, type McpEndpoint, type McpEndpoints } from '../../shared/mcp-endpoints.js';
import type { NotificationHub } from '../notification-hub.js';
import type { McpCallResult, McpResourceInfo, McpToolInfo } from './client.js';
import { McpServerClient } from './client.js';
import { HttpMcpTransport, StdioMcpTransport, type McpTransport } from './transport.js';

/** The public state of one endpoint, for the settings list and the page API. */
export interface McpServerState {
  readonly id: string;
  readonly label: string;
  readonly mode: McpEndpoint['mode'];
  readonly state: 'connecting' | 'connected' | 'error' | 'dormant';
  readonly error: string | null;
  readonly toolNames: readonly string[];
  readonly resourceUris: readonly string[];
}

/** One agent tool descriptor that the native mode contributes to the chat tool list. */
export interface McpNativeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly endpointId: string;
}

interface ServerRecord {
  readonly endpoint: McpEndpoint;
  client: McpServerClient | null;
  state: McpServerState['state'];
  error: string | null;
  tools: readonly McpToolInfo[];
  resources: readonly McpResourceInfo[];
}

function buildTransport(
  endpoint: McpEndpoint,
  onNotification: (method: string, params: unknown) => void,
): McpTransport {
  if (endpoint.transport.kind === 'http') {
    return new HttpMcpTransport(endpoint.transport.url, endpoint.transport.token, onNotification);
  }
  return new StdioMcpTransport(endpoint.transport.command, endpoint.transport.args ?? [], onNotification);
}

/** Reads the scheme of one URI, the part before the first colon. */
function schemeOf(uri: string): string {
  const separator = uri.indexOf(':');
  return separator === -1 ? '' : uri.slice(0, separator);
}

/** Owns the MCP server connections of the workspace. */
export class McpClientManager {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly runtimeEnabled = new Set<string>();
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly hub: NotificationHub) {}

  /** Applies the endpoint list: new endpoints connect per their mode, removed ones disconnect. */
  async applyEndpoints(endpoints: McpEndpoints): Promise<void> {
    const kept = new Set<string>();
    for (const endpoint of endpoints.endpoints) {
      kept.add(endpoint.id);
      const existing = this.servers.get(endpoint.id);
      if (existing !== undefined) {
        if (existing.endpoint !== endpoint) {
          this.replaceEndpoint(existing, endpoint);
        }
        continue;
      }
      const record: ServerRecord = {
        endpoint,
        client: null,
        state: endpoint.mode === 'none' || endpoint.mode === 'disabled' ? 'dormant' : 'connecting',
        error: null,
        tools: [],
        resources: [],
      };
      this.servers.set(endpoint.id, record);
      this.wantedConnected(endpoint) ? void this.connect(record) : this.notifyChange();
    }
    for (const [id, record] of this.servers) {
      if (!kept.has(id)) {
        record.client?.close();
        this.servers.delete(id);
        this.runtimeEnabled.delete(id);
      }
    }
    this.notifyChange();
  }

  private replaceEndpoint(record: ServerRecord, endpoint: McpEndpoint): void {
    record.client?.close();
    record.client = null;
    record.tools = [];
    record.resources = [];
    record.error = null;
    record.state = this.wantedConnected(endpoint) ? 'connecting' : 'dormant';
    this.servers.set(endpoint.id, { ...record, endpoint });
    if (this.wantedConnected(endpoint)) {
      void this.connect(this.servers.get(endpoint.id) as ServerRecord);
    }
    this.notifyChange();
  }

  /** True when the endpoint mode connects on its own, or the agent enabled it at runtime. */
  private wantedConnected(endpoint: McpEndpoint): boolean {
    if (endpoint.mode === 'native' || endpoint.mode === 'preloaded') {
      return true;
    }
    if (endpoint.mode === 'disabled') {
      return false;
    }
    return this.runtimeEnabled.has(endpoint.id);
  }

  private async connect(record: ServerRecord): Promise<void> {
    const endpoint = record.endpoint;
    try {
      const client = await McpServerClient.connect(
        endpoint,
        buildTransport(endpoint, (method, params) => {
          this.handleServerNotification(record, method, params);
        }),
      );
      record.client = client;
      record.tools = await client.listTools();
      try {
        record.resources = [...(await client.listResources()), ...(await client.listResourceTemplates())];
      } catch {
        // A server without the resources capability lists none. The tools still work.
        record.resources = [];
      }
      record.state = 'connected';
      record.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.client?.close();
      record.client = null;
      record.state = 'error';
      record.error = message;
      console.warn(`[NodeWavenUI] the MCP endpoint "${endpoint.label}" failed: ${message}`);
    }
    this.notifyChange();
  }

  /** Routes one notification from a remote server: the hub hears it, the chat gets one user message,
   * and the list notifications refresh their list. */
  private handleServerNotification(record: ServerRecord, method: string, params: unknown): void {
    const source = `mcp ${record.endpoint.label}`;
    this.hub.dispatch(method, params, source);
    this.hub.notifyChat(`[${source}] ${method}${params !== undefined ? ` ${JSON.stringify(params)}` : ''}`);
    if (record.client === null) {
      return;
    }
    if (method === 'notifications/tools/list_changed') {
      void record.client
        .listTools()
        .then((tools) => {
          record.tools = tools;
          this.notifyChange();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[NodeWavenUI] the tool list of "${record.endpoint.label}" did not refresh: ${message}`);
        });
    } else if (method === 'notifications/resources/list_changed') {
      void record.client
        .listResources()
        .then((resources) => {
          record.resources = resources;
        })
        .catch(() => {
          // A failed refresh keeps the last list. The next read retries on demand.
        });
    }
  }

  /** Lists the endpoint states. Disabled endpoints stay hidden. */
  listServers(): readonly McpServerState[] {
    const states: McpServerState[] = [];
    for (const record of this.servers.values()) {
      if (record.endpoint.mode === 'disabled') {
        continue;
      }
      states.push({
        id: record.endpoint.id,
        label: record.endpoint.label,
        mode: record.endpoint.mode,
        state: record.state,
        error: record.error,
        toolNames: record.tools.map((tool) => tool.name),
        resourceUris: record.resources.map((resource) => resource.uri),
      });
    }
    return states;
  }

  /** Enables one dormant endpoint at runtime. The agent reaches this through the page API. */
  async enable(idOrLabel: string): Promise<string> {
    const record = this.find(idOrLabel);
    if (record === null) {
      return this.apiError(`No MCP endpoint matches "${idOrLabel}".`);
    }
    if (record.endpoint.mode === 'disabled') {
      return this.apiError(`The MCP endpoint "${record.endpoint.label}" is disabled. Enable it in the settings.`);
    }
    if (record.state === 'connected' || record.state === 'connecting') {
      return JSON.stringify({ label: record.endpoint.label, state: record.state });
    }
    this.runtimeEnabled.add(record.endpoint.id);
    record.state = 'connecting';
    this.notifyChange();
    await this.connect(record);
    return JSON.stringify({ label: record.endpoint.label, state: record.state, error: record.error });
  }

  /** Disconnects one runtime-enabled endpoint. Configured modes (native, preloaded) reconnect on the next apply. */
  disable(idOrLabel: string): string {
    const record = this.find(idOrLabel);
    if (record === null) {
      return this.apiError(`No MCP endpoint matches "${idOrLabel}".`);
    }
    if (record.endpoint.mode !== 'none') {
      return this.apiError(`The MCP endpoint "${record.endpoint.label}" follows its configured mode. Only mode "none" endpoints disable at runtime.`);
    }
    this.runtimeEnabled.delete(record.endpoint.id);
    record.client?.close();
    record.client = null;
    record.tools = [];
    record.resources = [];
    record.state = 'dormant';
    this.notifyChange();
    return JSON.stringify({ label: record.endpoint.label, state: record.state });
  }

  private find(idOrLabel: string): ServerRecord | null {
    for (const record of this.servers.values()) {
      if (record.endpoint.id === idOrLabel || record.endpoint.label === idOrLabel) {
        return record;
      }
    }
    return null;
  }

  private connectedRecords(): readonly ServerRecord[] {
    return [...this.servers.values()].filter((record) => record.state === 'connected');
  }

  /** Calls one tool of one endpoint by id or label. */
  async callTool(idOrLabel: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const record = this.find(idOrLabel);
    if (record === null || record.client === null) {
      throw new Error(`The MCP endpoint "${idOrLabel}" is not connected.`);
    }
    return record.client.callTool(toolName, args);
  }

  /** Reads one resource URI on the connected server that claims its scheme or lists it. */
  async readResource(uri: string): Promise<string> {
    const scheme = schemeOf(uri);
    for (const record of this.connectedRecords()) {
      const exact = record.resources.find((resource) => resource.uri === uri);
      if (exact === undefined) {
        continue;
      }
      return this.renderContents(await record.client?.readResource(uri) ?? []);
    }
    for (const record of this.connectedRecords()) {
      const claimsScheme = record.resources.some(
        (resource) => scheme.length > 0 && schemeOf(resource.uri) === scheme,
      );
      if (claimsScheme) {
        return this.renderContents(await record.client?.readResource(uri) ?? []);
      }
    }
    throw new Error(`No connected MCP server claims the URI ${uri}.`);
  }

  private renderContents(contents: readonly { readonly uri: string; readonly mimeType: string | null; readonly text: string | null; readonly blob: string | null }[]): string {
    const parts: string[] = [];
    for (const content of contents) {
      if (content.text !== null) {
        parts.push(content.text);
      } else if (content.blob !== null) {
        parts.push(`[${content.mimeType ?? 'unknown'} base64 content of ${content.uri}]`);
      }
    }
    return parts.join('\n');
  }

  /** The native tools of every connected native endpoint, prefixed `<sanitized-label>.<tool>`. */
  nativeTools(): readonly McpNativeTool[] {
    const tools: McpNativeTool[] = [];
    for (const record of this.connectedRecords()) {
      if (record.endpoint.mode !== 'native') {
        continue;
      }
      const prefix = sanitizeEndpointLabel(record.endpoint.label);
      for (const tool of record.tools) {
        tools.push({
          name: `${prefix}.${tool.name}`,
          description: `${record.endpoint.label}: ${tool.description}`,
          inputSchema: tool.inputSchema,
          endpointId: record.endpoint.id,
        });
      }
    }
    return tools;
  }

  /** Runs one native tool by its prefixed name. */
  async runNativeTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    for (const tool of this.nativeTools()) {
      if (tool.name === name) {
        return this.callTool(tool.endpointId, name.slice(name.indexOf('.') + 1), args);
      }
    }
    throw new Error(`No native MCP tool matches "${name}".`);
  }

  /** Subscribes to every connection state change. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private apiError(message: string): string {
    return JSON.stringify({ error: message });
  }

  private cachedPageApi: Record<string, (...parameters: readonly unknown[]) => Promise<string> | string> | null = null;

  /**
   * The page API for evaluated code, mounted on the main window and injected into child windows.
   * Every method answers with JSON text, so the values cross window contexts safely.
   * The calls run in the main context with full reach: the evaluate tool that reaches this API
   * already passed the permission gate.
   */
  get pageApi(): Record<string, (...parameters: readonly unknown[]) => Promise<string> | string> {
    if (this.cachedPageApi !== null) {
      return this.cachedPageApi;
    }
    this.cachedPageApi = {
      list: async (): Promise<string> => JSON.stringify(this.listServers()),
      call: async (idOrLabel: unknown, toolName: unknown, args: unknown): Promise<string> => {
        try {
          const result = await this.callTool(String(idOrLabel), String(toolName), asArgs(args));
          return JSON.stringify(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return this.apiError(message);
        }
      },
      enable: async (idOrLabel: unknown): Promise<string> => this.enable(String(idOrLabel)),
      disable: (idOrLabel: unknown): string => this.disable(String(idOrLabel)),
      resources: async (idOrLabel?: unknown): Promise<string> => {
        const records =
          idOrLabel === undefined ? this.connectedRecords() : [this.find(String(idOrLabel))].filter(isServerRecord);
        return JSON.stringify(
          records.map((record) => ({ label: record.endpoint.label, resources: record.resources })),
        );
      },
      read: async (uri: unknown): Promise<string> => {
        try {
          return await this.readResource(String(uri));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return this.apiError(message);
        }
      },
      notify: (...parts: readonly unknown[]): string => {
        this.hub.notifyChat(...parts);
        return JSON.stringify({ notified: true });
      },
      onNotification: (method: unknown, listener: unknown): string => {
        const name = typeof method === 'string' ? method : '*';
        if (typeof listener !== 'function') {
          return this.apiError('onNotification needs a method name and a callback function.');
        }
        const id = this.hub.subscribe(name, (heard, params, source) => {
          const part = listener(heard, params, source);
          if (part !== null && typeof part === 'object' && typeof (part as { then?: unknown }).then === 'function') {
            void (part as Promise<unknown>).catch(() => {
              // A rejected listener callback is the listener's business. The dispatch goes on.
            });
          }
        });
        return JSON.stringify({ listenerId: id });
      },
      offNotification: (id: unknown): string => {
        this.hub.unsubscribe(typeof id === 'number' ? id : -1);
        return JSON.stringify({ removed: true });
      },
    };
    return this.cachedPageApi;
  }
}

function isServerRecord(value: ServerRecord | null): value is ServerRecord {
  return value !== null;
}

function asArgs(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
