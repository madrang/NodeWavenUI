/**
 * One MCP server connection: the legacy-era handshake, the tool list, and the resources.
 * The results pass runtime guards at this boundary, so the manager works with typed values only.
 */

import { asRecord } from '../shared/records.js';
import { retry } from '../shared/retry.js';
import type { McpCallResult, McpEndpoint, McpImage } from '../shared/mcp-endpoints.js';
import { HttpMcpTransport, MCP_HANDSHAKE_TIMEOUT_MS, McpNetworkError, type McpTransport } from './mcp-transport.js';

/** The attempts of one endpoint connect, the first try included. The values mirror the connect
 * retry of a chat provider: a stalled connect retries, a running call never does. */
const CONNECT_ATTEMPTS = 4;
/** The wait before the first connect retry. Every later retry doubles it: 4s, 8s, 16s. */
const CONNECT_BASE_DELAY_MS = 4000;

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
      if (coerced) {
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
  const images: McpImage[] = [];
  for (const block of blocks) {
    const entry = asRecord(block);
    if (!entry) {
      continue;
    }
    if (entry.type === 'text') {
      parts.push(readString(entry.text));
    } else if (entry.type === 'image') {
      const data = asString(entry.data);
      if (data) {
        images.push({ data, mimeType: readString(entry.mimeType, 'image/png') });
      }
    } else if (entry.type === 'audio') {
      parts.push(`[${readString(entry.mimeType, 'unknown')} audio]`);
    } else if (entry.type === 'resource_link') {
      parts.push(`[resource ${readString(entry.uri)}]`);
    } else if (entry.type === 'resource') {
      const resource = asRecord(entry.resource);
      const text = resource ? asString(resource.text) : null;
      // eslint-disable-next-line local/prefer-truthiness -- an empty resource text is a valid render, only null falls back
      parts.push(text !== null ? text : `[resource ${resource ? readString(resource.uri) : 'unknown'}]`);
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
   * Connects one endpoint: opens the transport and runs the initialize handshake. A connect-class
   * failure retries with a backoff, because the server ran nothing. A server-answered failure —
   * an HTTP error or a JSON-RPC error reply — fails at once, because the retry would ask a live
   * server the same question again.
   *
   * @param endpoint The configured endpoint.
   * @param transport The transport that carries the messages.
   * @throws Error when the handshake fails or the server answers no valid initialize result.
   */
  static async connect(endpoint: McpEndpoint, transport: McpTransport): Promise<McpServerClient> {
    let result: unknown;
    try {
      result = await McpServerClient.handshake(endpoint, transport);
    } catch (error) {
      transport.close();
      throw error;
    }
    const record = asRecord(result);
    if (!record) {
      transport.close();
      throw new Error(`The MCP endpoint "${endpoint.label}" answered no valid initialize result.`);
    }
    const serverInfo = asRecord(record.serverInfo);
    transport.notify('notifications/initialized', {});
    const client = new McpServerClient(endpoint, transport, readString(serverInfo?.name, endpoint.label));
    // A lost session answers 404: the transport then re-runs the handshake and replays the call.
    if (transport instanceof HttpMcpTransport) {
      transport.recoverSessions(async () => {
        await McpServerClient.handshake(endpoint, transport);
        transport.notify('notifications/initialized', {});
      });
    }
    return client;
  }

  /** Runs the initialize handshake under its short cap, and retries the connect-class failures. */
  private static handshake(endpoint: McpEndpoint, transport: McpTransport): Promise<unknown> {
    return retry(
      () => transport.request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'nodewavenui', version: '0.2.0' } },
        MCP_HANDSHAKE_TIMEOUT_MS,
      ),
      {
        attempts: CONNECT_ATTEMPTS,
        baseDelayMs: CONNECT_BASE_DELAY_MS,
        retryOn: (error) => error instanceof McpNetworkError,
      },
    );
  }

  /** Lists every page of one list call of the server. The entries that fail coercion are
   * skipped, and a broken cursor loop stops at the page cap. */
  private async listPages<T>(
    method: string,
    coerce: (value: unknown) => unknown,
    entryKind: string,
  ): Promise<readonly T[]> {
    const entries: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params: Record<string, unknown> = {};
      if (cursor) {
        params.cursor = cursor;
      }
      const listPage = readListPage(await this.transport.request(method, params), coerce, entryKind);
      for (const entry of listPage.entries) {
        entries.push(entry as T);
      }
      if (!listPage.nextCursor) {
        break;
      }
      cursor = listPage.nextCursor;
    }
    return entries;
  }

  /** Lists the tools of the server, every page. */
  listTools(): Promise<readonly McpToolInfo[]> {
    return this.listPages<McpToolInfo>('tools/list', McpServerClient.coerceTool, 'tools');
  }

  private static coerceTool(value: unknown): unknown {
    const record = asRecord(value);
    if (!record || typeof record.name !== 'string' || record.name.length === 0) {
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

  /** Lists the resources of the server, every page. */
  listResources(): Promise<readonly McpResourceInfo[]> {
    return this.listPages<McpResourceInfo>('resources/list', McpServerClient.coerceResource, 'resources');
  }

  /** Lists the resource templates of the server, every page. */
  listResourceTemplates(): Promise<readonly McpResourceInfo[]> {
    return this.listPages<McpResourceInfo>('resources/templates/list', McpServerClient.coerceTemplate, 'resourceTemplates');
  }

  private static coerceResource(value: unknown): unknown {
    const record = asRecord(value);
    if (!record || typeof record.uri !== 'string' || record.uri.length === 0) {
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
    if (!record || typeof record.uriTemplate !== 'string' || record.uriTemplate.length === 0) {
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
      if (!entry || typeof entry.uri !== 'string') {
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
