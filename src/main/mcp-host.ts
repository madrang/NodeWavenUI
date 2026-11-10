/**
 * The MCP host of the main process: a streamable HTTP JSON-RPC server that serves the window
 * tools of the session service to external agents. Every session and tool call reaches the
 * workspace page as sink traffic, and the access token persists in the workspace storage.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { asRecord } from '../shared/records.js';
import { WINDOW_TOOL_DEFINITIONS } from '../shared/window-tools.js';
import { sessions, type WindowCaller } from './session-service.js';
import { callWorkspace, pushWorkspace } from './workspace-link.js';

/** Every tool of the host acts as this principal. */
const HOST_PRINCIPAL = 'mcp' as const;

/** One content block of a tool result. */
export interface McpContentBlock {
  readonly type: 'text' | 'image';
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

/** One tool result of the host. */
export interface McpToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/** One tool descriptor of the host. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: Record<string, unknown>, caller: WindowCaller) => Promise<McpToolResult>;
}

/** The listen configuration of the host. */
export interface McpHostConfig {
  readonly port: number;
  readonly interface: string;
}

/** The facts of one MCP host connection, for the connection post of the host tab. */
export interface McpConnectionInfo {
  readonly clientName: string | null;
  readonly clientVersion: string | null;
  readonly protocolVersion: string | null;
  readonly userAgent: string | null;
}

/** Reads a string argument of one tool call. */
function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The argument "${name}" needs a non-empty string.`);
  }
  return value;
}

/** Reads a child id argument of one tool call. */
function requireChildId(args: Record<string, unknown>): number {
  const value = args['childId'];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('The argument "childId" needs an integer.');
  }
  return value;
}

/** Reads a string option of one tool call. */
function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Wraps one text as a tool result. */
function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Builds the window tools both surfaces serve: this host and the chat agent registry. */
export function createTools(): McpToolDescriptor[] {
  const handlers: Record<string, (args: Record<string, unknown>, caller: WindowCaller) => Promise<McpToolResult>> = {
    list_windows: async () => textResult(JSON.stringify(sessions.listChildren(), null, 2)),
    open_window: async (args, caller) => {
      const url = requireString(args, 'url');
      const frame = optionalString(args, 'frame');
      const id = await sessions.openChild(caller, url, {
        ...(typeof args['width'] === 'number' ? { width: args['width'] } : {}),
        ...(typeof args['height'] === 'number' ? { height: args['height'] } : {}),
        ...(frame ? { frame: frame === 'system' } : {}),
      });
      return textResult(`Child window ${id} opened for ${url}.`);
    },
    open_frame: async (args, caller) => {
      const url = requireString(args, 'url');
      const kind = args['kind'] === 'webview' ? 'webview' : args['kind'] === 'iframe' ? 'iframe' : null;
      if (!kind) {
        throw new Error('The argument "kind" must be "iframe" or "webview".');
      }
      const sideArgument = args['side'];
      const side = sideArgument === 'left' ? 'left' : sideArgument === 'right' ? 'right' : 'right';
      const title = typeof args['title'] === 'string' && args['title'].length > 0 ? args['title'] : null;
      const frame = await sessions.openFrame(caller, url, kind, side, title);
      return textResult(JSON.stringify(frame));
    },
    close_window: async (args, caller) => {
      const id = requireChildId(args);
      await sessions.closeChild(caller, id);
      return textResult(`Child window ${id} closed.`);
    },
    attach_session: async (args, caller) => {
      const id = requireChildId(args);
      await sessions.attach(caller, id);
      return textResult(`Debug session attached to child window ${id}.`);
    },
    detach_session: async (args, caller) => {
      const id = requireChildId(args);
      await sessions.detach(caller, id);
      return textResult(`Debug session detached from child window ${id}.`);
    },
    evaluate: async (args, caller) => {
      const result = await sessions.evaluate(caller, requireChildId(args), requireString(args, 'expression'));
      return textResult(JSON.stringify(result));
    },
    screenshot: async (args, caller) => {
      const format = args['format'] === 'jpeg' ? 'jpeg' : 'png';
      const data = await sessions.captureScreenshot(caller, requireChildId(args), format);
      return { content: [{ type: 'image', data, mimeType: `image/${format}` }] };
    },
    console_entries: async (args, caller) => {
      const entries = await sessions.consoleEntries(caller, requireChildId(args));
      return textResult(JSON.stringify(entries, null, 2));
    },
    clear_console: async (args, caller) => {
      const id = requireChildId(args);
      await sessions.clearConsole(caller, id);
      return textResult(`Console of child window ${id} cleared.`);
    },
    navigate: async (args, caller) => {
      const id = requireChildId(args);
      const url = requireString(args, 'url');
      await sessions.navigate(caller, id, url);
      return textResult(`Child window ${id} navigated to ${url}.`);
    },
    open_devtools: async (args, caller) => {
      const id = requireChildId(args);
      await sessions.openDevTools(caller, id);
      return textResult(`DevTools of child window ${id} opened.`);
    },
  };
  return WINDOW_TOOL_DEFINITIONS.flatMap((definition) => {
    const handler = handlers[definition.name];
    return handler ?
      [{ name: definition.name, description: definition.description, inputSchema: definition.inputSchema, handler }] :
      [];
  });
}

/** Renders one tool result into one summary line for the session tab. */
function summarizeToolResult(result: McpToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      parts.push(block.text ?? '');
    } else {
      parts.push(`[${block.mimeType} image]`);
    }
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 240 ? `${joined.slice(0, 237)}…` : joined;
}

/** Reads the image blocks of one result, for the thumbnails of the session tab. */
function imagesOfResult(result: McpToolResult): { data: string; mimeType: string }[] {
  const images: { data: string; mimeType: string }[] = [];
  for (const block of result.content) {
    if (block.type !== 'text' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      images.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return images;
}

/** Reads the JSON object of one result whose only content is one JSON text block. */
function jsonOfResult(result: McpToolResult): unknown {
  const block = result.content[0];
  if (result.content.length !== 1 || block?.type !== 'text') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(block.text ?? '');
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the body of one request. */
function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: string | Buffer) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });
    request.on('end', () => {
      resolve(body);
    });
  });
}

/** Answers one request with plain text. */
function respondPlainText(response: http.ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

/** The handle of the running host, for the settings pane. */
export interface McpHostHandle {
  /** Reads the endpoint the clients connect to. */
  readEndpoint(): string;
  /** Reads the access token. */
  readAccessToken(): Promise<string>;
  /** Stops the server. The app quit closes it with the process. */
  stop(): void;
}

/** Parses the `--mcp-host=<port>[:<interface>]` argument. */
export function parseMcpHostArgument(argv: readonly string[]): McpHostConfig | null {
  const argument = argv.find((item) => item.startsWith('--mcp-host='));
  if (!argument) {
    return null;
  }
  const value = argument.slice('--mcp-host='.length);
  const separator = value.indexOf(':');
  const portText = separator === -1 ? value : value.slice(0, separator);
  const interfaceAddress = separator === -1 ? '127.0.0.1' : value.slice(separator + 1);
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`The --mcp-host port "${portText}" is not a valid port.`);
  }
  return { port, interface: interfaceAddress };
}

/** Generates one access token. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads one string field of a JSON value. */
function readStringField(value: unknown, field: string): string | null {
  const candidate = asRecord(value)?.[field];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** The running host, set once. */
let runningHost: McpHostHandle | null = null;

/** Reads the facts of the running host for the settings pane. */
export async function readMcpHostInfo(): Promise<{ endpoint: string; token: string } | null> {
  if (!runningHost) {
    return null;
  }
  return { endpoint: runningHost.readEndpoint(), token: await runningHost.readAccessToken() };
}

/**
 * Starts the MCP host. The workspace page calls this once its storage is open, so the token
 * loads from the workspace settings.
 *
 * @param config The listen configuration.
 * @returns The handle of the running server.
 */
export async function startMcpHost(config: McpHostConfig): Promise<McpHostHandle> {
  if (runningHost) {
    return runningHost;
  }
  // The token loads from the workspace storage; a read failure surfaces instead of rotating
  // the token, because a silent rotation cuts every configured client off.
  const stored = await callWorkspace<string | null>('mcp.token.load', null);
  const token = typeof stored === 'string' && stored.length >= 32 ? stored : generateToken();
  if (token !== stored) {
    await callWorkspace('mcp.token.save', token);
  }
  const tools = createTools();
  const fallbackSessionId = crypto.randomUUID();
  const server = http.createServer((request, response) => {
    void handleMcpRequest(request, response, tools, token, fallbackSessionId);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.interface, () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://${config.interface}:${typeof address?.port === 'number' ? address.port : config.port}/mcp`;
  console.info(`[NodeWavenUI] MCP host listening on ${endpoint}`);
  runningHost = {
    readEndpoint: () => endpoint,
    readAccessToken: () => Promise.resolve(token),
    stop: () => {
      server.close();
      runningHost = null;
    },
  };
  return runningHost;
}

/** Answers one MCP message. */
async function answer(
  message: unknown,
  tools: readonly McpToolDescriptor[],
  token: string,
  fallbackSessionId: string,
  userAgent: string | null,
): Promise<unknown> {
  const record = asRecord(message);
  const id = record?.['id'];
  const method = record?.['method'];
  const params = asRecord(record?.['params']) ?? {};
  if (method === 'initialize') {
    pushWorkspace('mcp.sink', {
      kind: 'sessionOpened',
      info: {
        clientName: readStringField(params['clientInfo'], 'name'),
        clientVersion: readStringField(params['clientInfo'], 'version'),
        protocolVersion: readStringField(params, 'protocolVersion'),
        userAgent,
      },
    });
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'nodewavenui', version: '0.2.0' } } };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } };
  }
  if (method === 'tools/call') {
    const name = params['name'];
    if (typeof name !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'The tool call carries no name.' } };
    }
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `The tool "${name}" is unknown.` } };
    }
    const args = asRecord(params['arguments']) ?? {};
    const sessionId = fallbackSessionId;
    const caller: WindowCaller = { principal: HOST_PRINCIPAL, source: sessionId };
    pushWorkspace('mcp.sink', { kind: 'toolCall', sessionId, toolName: name, args });
    let result: McpToolResult;
    try {
      result = await tool.handler(args, caller);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      result = { content: [{ type: 'text', text: messageText }], isError: true };
    }
    pushWorkspace('mcp.sink', {
      kind: 'toolResult',
      sessionId,
      toolName: name,
      summary: summarizeToolResult(result),
      isError: result.isError === true,
      json: jsonOfResult(result),
      images: imagesOfResult(result),
    });
    return { jsonrpc: '2.0', id, result };
  }
  if (method === 'resources/list' || method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }
  if (method === 'resources/read') {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'This server serves no resources.' } };
  }
  if (typeof method === 'string' && method.length > 0 && !('id' in (record ?? {}))) {
    pushWorkspace('mcp.sink', { kind: 'clientNotification', sessionId: fallbackSessionId, method, params: record?.['params'] ?? null });
    return null;
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `The method "${String(method)}" is unknown.` } };
}

/** Handles one HTTP request of the host. */
async function handleMcpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  tools: readonly McpToolDescriptor[],
  token: string,
  fallbackSessionId: string,
): Promise<void> {
  if (request.method !== 'POST') {
    respondPlainText(response, 405, 'The MCP host serves POST requests only.');
    return;
  }
  const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
  if (authorization !== `Bearer ${token}`) {
    respondPlainText(response, 401, 'The bearer token is missing or wrong.');
    return;
  }
  const body = await readRequestBody(request);
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    respondPlainText(response, 400, 'The request body holds no valid JSON.');
    return;
  }
  const userAgent = typeof request.headers['user-agent'] === 'string' ? (request.headers['user-agent'] as string) : null;
  const reply = await answer(message, tools, token, fallbackSessionId, userAgent);
  if (!reply) {
    response.writeHead(202);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(reply));
}
