/**
 * One MCP server connection: the legacy-era handshake, the tool list, and the resources.
 * The results pass runtime guards at this boundary, so the manager works with typed values only.
 */

import { asRecord } from '../../shared/records.js';
import type { ChatImage } from '../../providers/provider.js';
import type { McpEndpoint } from '../../shared/mcp-endpoints.js';
import type { McpTransport } from './transport.js';

/** The protocol version the client speaks, the same as the app's own MCP host. */
const PROTOCOL_VERSION = '2025-06-18';
/** How many pages one list call reads at most, so a broken cursor loop cannot spin forever. */
const MAX_LIST_PAGES = 32;

/** One tool a remote server offers. */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One resource a remote server offers. */
export interface McpResourceInfo {
  readonly uri: string;
  readonly name: string;
  readonly description: string | null;
  readonly mimeType: string | null;
  /** True when the entry came from a resource template, not a concrete resource. */
  readonly fromTemplate: boolean;
}

/** One content block of a resource read. Either text or blob holds data. */
export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: string | null;
  readonly text: string | null;
  readonly blob: string | null;
}

/** One tool call result of a remote server: the text and the image blocks. */
export interface McpCallResult {
  readonly text: string;
  readonly isError: boolean;
  readonly images: readonly ChatImage[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readSchema(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? { type: 'object', properties: {} };
}

/** Reads the entries of one list page and its cursor. The entries that fail coercion are skipped. */
function readListPage(
  result: unknown,
  readEntry: (value: unknown) => unknown,
  entryKind: string,
): { entries: unknown[]; nextCursor: string | null } {
  const record = asRecord(result) ?? {};
  const rawEntries = record[entryKind];
  const entries: unknown[] = [];
  if (Array.isArray(rawEntries)) {
    for (const raw of rawEntries) {
      const coerced = readEntry(raw);
      if (coerced !== null) {
        entries.push(coerced);
      }
    }
  }
  return { entries, nextCursor: asString(record.nextCursor) };
}

/** Renders the content blocks of one tool call into one result for the agent: text parts and image blocks. */
function renderCallContent(result: unknown): McpCallResult {
  const record = asRecord(result) ?? {};
  const blocks = Array.isArray(record.content) ? record.content : [];
  const parts: string[] = [];
  const images: ChatImage[] = [];
  for (const block of blocks) {
    const entry = asRecord(block);
    if (entry === null) {
      continue;
    }
    if (entry.type === 'text') {
      parts.push(readString(entry.text));
    } else if (entry.type === 'image') {
      const data = asString(entry.data);
      if (data !== null && data.length > 0) {
        images.push({ data, mimeType: readString(entry.mimeType, 'image/png') });
      }
    } else if (entry.type === 'audio') {
      parts.push(`[${readString(entry.mimeType, 'unknown')} audio]`);
    } else if (entry.type === 'resource_link') {
      parts.push(`[resource ${readString(entry.uri)}]`);
    } else if (entry.type === 'resource') {
      const resource = asRecord(entry.resource);
      const text = resource !== null ? asString(resource.text) : null;
      parts.push(text !== null ? text : `[resource ${resource !== null ? readString(resource.uri) : 'unknown'}]`);
    }
  }
  const text = parts.length > 0 ? parts.join('\n') : JSON.stringify(result);
  return { text, isError: readBoolean(record.isError), images };
}

/** One connected MCP server. */
export class McpServerClient {
  private constructor(
    readonly endpoint: McpEndpoint,
    private readonly transport: McpTransport,
    readonly serverName: string,
  ) {}

  /**
   * Connects one endpoint: opens the transport and runs the initialize handshake.
   *
   * @param endpoint The configured endpoint.
   * @param transport The transport that carries the messages.
   * @throws Error when the handshake fails or the server answers no valid initialize result.
   */
  static async connect(endpoint: McpEndpoint, transport: McpTransport): Promise<McpServerClient> {
    const result = await transport.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nodewavenui', version: '0.1.0' },
    });
    const record = asRecord(result);
    if (record === null) {
      transport.close();
      throw new Error(`The MCP endpoint "${endpoint.label}" answered no valid initialize result.`);
    }
    const serverInfo = asRecord(record.serverInfo);
    transport.notify('notifications/initialized', {});
    return new McpServerClient(endpoint, transport, readString(serverInfo?.name, endpoint.label));
  }

  /** Lists the tools of the server, every page. */
  async listTools(): Promise<readonly McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params: Record<string, unknown> = {};
      if (cursor !== null) {
        params.cursor = cursor;
      }
      const result = await this.transport.request('tools/list', params);
      const listPage = readListPage(result, McpServerClient.coerceTool, 'tools');
      for (const entry of listPage.entries) {
        tools.push(entry as McpToolInfo);
      }
      if (listPage.nextCursor === null || listPage.nextCursor.length === 0) {
        break;
      }
      cursor = listPage.nextCursor;
    }
    return tools;
  }

  private static coerceTool(value: unknown): unknown {
    const record = asRecord(value);
    if (record === null || typeof record.name !== 'string' || record.name.length === 0) {
      return null;
    }
    return {
      name: record.name,
      description: readString(record.description),
      inputSchema: readSchema(record.inputSchema),
    } satisfies McpToolInfo;
  }

  /** Calls one tool of the server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.transport.request('tools/call', { name, arguments: args });
    return renderCallContent(result);
  }

  /** Lists the resources and the resource templates of the server. */
  async listResources(): Promise<readonly McpResourceInfo[]> {
    const resources: McpResourceInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params: Record<string, unknown> = {};
      if (cursor !== null) {
        params.cursor = cursor;
      }
      const result = await this.transport.request('resources/list', params);
      const listPage = readListPage(result, McpServerClient.coerceResource, 'resources');
      for (const entry of listPage.entries) {
        resources.push(entry as McpResourceInfo);
      }
      if (listPage.nextCursor === null || listPage.nextCursor.length === 0) {
        break;
      }
      cursor = listPage.nextCursor;
    }
    return resources;
  }

  /** Lists the concrete and template resource URIs, merged into one scheme map helper list. */
  async listResourceTemplates(): Promise<readonly McpResourceInfo[]> {
    const templates: McpResourceInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params: Record<string, unknown> = {};
      if (cursor !== null) {
        params.cursor = cursor;
      }
      const result = await this.transport.request('resources/templates/list', params);
      const listPage = readListPage(result, McpServerClient.coerceTemplate, 'resourceTemplates');
      for (const entry of listPage.entries) {
        templates.push(entry as McpResourceInfo);
      }
      if (listPage.nextCursor === null || listPage.nextCursor.length === 0) {
        break;
      }
      cursor = listPage.nextCursor;
    }
    return templates;
  }

  private static coerceResource(value: unknown): unknown {
    const record = asRecord(value);
    if (record === null || typeof record.uri !== 'string' || record.uri.length === 0) {
      return null;
    }
    return {
      uri: record.uri,
      name: readString(record.name, record.uri),
      description: asString(record.description),
      mimeType: asString(record.mimeType),
      fromTemplate: false,
    } satisfies McpResourceInfo;
  }

  private static coerceTemplate(value: unknown): unknown {
    const record = asRecord(value);
    if (record === null || typeof record.uriTemplate !== 'string' || record.uriTemplate.length === 0) {
      return null;
    }
    return {
      uri: record.uriTemplate,
      name: readString(record.name, record.uriTemplate),
      description: asString(record.description),
      mimeType: asString(record.mimeType),
      fromTemplate: true,
    } satisfies McpResourceInfo;
  }

  /** Reads one resource by URI. */
  async readResource(uri: string): Promise<readonly McpResourceContent[]> {
    const result = await this.transport.request('resources/read', { uri });
    const record = asRecord(result) ?? {};
    const rawContents = Array.isArray(record.contents) ? record.contents : [];
    const contents: McpResourceContent[] = [];
    for (const raw of rawContents) {
      const entry = asRecord(raw);
      if (entry === null || typeof entry.uri !== 'string') {
        continue;
      }
      contents.push({
        uri: entry.uri,
        mimeType: asString(entry.mimeType),
        text: asString(entry.text),
        blob: asString(entry.blob),
      });
    }
    if (contents.length === 0) {
      throw new Error(`The MCP server "${this.serverName}" returned no content for ${uri}.`);
    }
    return contents;
  }

  /** Closes the transport of the server. */
  close(): void {
    this.transport.close();
  }
}
