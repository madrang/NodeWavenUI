/**
 * Optional MCP host that exposes the child window debug sessions to external agents over HTTP.
 * The command line argument `--mcp-host=<port>[:<interface>]` starts the host. Without an interface it binds to 127.0.0.1 only.
 * The access token persists in the workspace storage, so it stays the same across launches. The log never prints it;
 * the settings pane shows it while the host runs. Every request carries the token in the Authorization header.
 */

import { listHarnessDocs, readHarnessDoc, HARNESS_DOC_MIME_TYPE } from './doc-resources.js';
import { FRAME_MODES, isKnownFrameMode } from './frame-mode.js';
import type { ChildWindowManager, WindowCaller } from './window-manager.js';
import { requireNodeModule } from '../shared/node-access.js';
import { asRecord } from '../shared/records.js';

/** Every tool of the host acts as this principal. */
const HOST_PRINCIPAL = 'mcp' as const;

/** Receives the session lifecycle and the tool traffic of the host, so the main app can log it into chat tabs. */
export interface McpSessionSink {
  /** A session the host has not seen before opened. */
  sessionOpened(sessionId: string): void;
  /** A session started one tool call. */
  toolCall(sessionId: string, toolName: string, args: Record<string, unknown>): void;
  /** A session finished one tool call. The json payload carries the parsed object of one JSON reply, when present. */
  toolResult(sessionId: string, toolName: string, summary: string, isError: boolean, json?: unknown): void;
  /** A session sent one JSON-RPC notification to the host. */
  clientNotification(sessionId: string, method: string, params: unknown): void;
}

/** The token persistence the host needs. The settings store of the workspace implements it. */
export interface McpHostTokenStore {
  loadMcpHostToken(): Promise<string | null>;
  saveMcpHostToken(token: string): Promise<void>;
}

/** The running host, for the settings pane. */
export interface McpHostHandle {
  /** The HTTP endpoint of the host. */
  readonly endpoint: string;
  /** Reads the access token for the settings pane reveal. */
  readAccessToken(): string;
}

/** The listen configuration of the MCP host. */
export interface McpHostConfig {
  readonly port: number;
  readonly interface: string;
}

const MCP_HOST_ARGUMENT = '--mcp-host';
const DEFAULT_INTERFACE = '127.0.0.1';
const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Parses the MCP host argument from one argument list.
 *
 * @param argv The arguments to scan.
 * @returns The configuration, or null when the argument is absent.
 * @throws Error when the argument value does not match `<port>[:<interface>]`.
 */
export function parseMcpHostArg(argv: readonly string[]): McpHostConfig | null {
  const prefix = `${MCP_HOST_ARGUMENT}=`;
  for (const argument of argv) {
    if (!argument.startsWith(prefix)) {
      continue;
    }
    const value = argument.slice(prefix.length);
    const separator = value.indexOf(':');
    const portText = separator === -1 ? value : value.slice(0, separator);
    const hostText = separator === -1 ? DEFAULT_INTERFACE : value.slice(separator + 1);
    const port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || hostText.length === 0) {
      throw new Error(
        `Invalid ${MCP_HOST_ARGUMENT} value "${value}". Expected ${MCP_HOST_ARGUMENT}=<port>[:<interface>].`,
      );
    }
    return { port, interface: hostText };
  }
  return null;
}

/**
 * Reads the MCP host configuration from the command line of the running app.
 * The arguments come from `process.argv` and from `nw.App.argv`, so both launch styles work.
 *
 * @returns The configuration, or null when the argument is absent.
 * @throws Error when the argument value is invalid.
 */
export function mcpHostConfigFromProcess(): McpHostConfig | null {
  const argv: string[] = [];
  const processArgv = (globalThis as { process?: { argv?: unknown } }).process?.argv;
  if (Array.isArray(processArgv)) {
    argv.push(...processArgv.filter((item): item is string => typeof item === 'string'));
  }
  const appArgv = (globalThis as { nw?: { App?: { argv?: unknown } } }).nw?.App?.argv;
  if (Array.isArray(appArgv)) {
    argv.push(...appArgv.filter((item): item is string => typeof item === 'string'));
  }
  return parseMcpHostArg(argv);
}

/** The slice of the Node http module the host uses. */
interface NodeHttpModule {
  createServer(handler: (request: NodeHttpRequest, response: NodeHttpResponse) => void): NodeHttpServer;
}

interface NodeHttpServer {
  listen(port: number, host: string, callback: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

interface NodeHttpRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: unknown) => void): void;
  on(event: 'end', listener: () => void): void;
}

interface NodeHttpResponse {
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(data?: string): void;
}

/** One JSON-RPC reply of the host. */
type JsonRpcReply =
  | { readonly jsonrpc: '2.0'; readonly id: unknown; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: unknown; readonly error: { readonly code: number; readonly message: string } };

/** One MCP content block of a tool result. */
export type McpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** One MCP tool result. */
export interface McpToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/** One MCP tool the host offers. */
interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: Record<string, unknown>, caller: WindowCaller) => Promise<McpToolResult>;
}

/** The per-request context a message dispatch works with. */
interface McpRequestContext {
  readonly sessionId: string;
  readonly sink: McpSessionSink;
}

const bodyDecoder = new TextDecoder();

function createAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`The argument "${name}" must be an integer.`);
  }
  return value;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The argument "${name}" must be a non-empty string.`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`The argument "${name}" must be an integer.`);
  }
  return value;
}

/**
 * Reads the optional frame argument of one window tool.
 *
 * @param args The call arguments.
 * @returns The frame flag: true for the system border, false for borderless. Undefined inherits the workspace window.
 * @throws Error when the value names no registered frame mode.
 */
function optionalFrame(args: Record<string, unknown>): boolean | undefined {
  const value = args['frame'];
  if (value === undefined) {
    return undefined;
  }
  if (!isKnownFrameMode(value)) {
    throw new Error('The argument "frame" must be "system" or "borderless".');
  }
  return value === 'system';
}

function childIdSchema(): Record<string, unknown> {
  return { type: 'integer', description: 'The id of the child window.' };
}

/**
 * Builds the window tool descriptors over one child window manager.
 * Two surfaces serve them: the MCP host over HTTP, and the chat agent registry as built-in tools.
 *
 * @param manager The child window manager the tools drive.
 * @returns The descriptors, each acting as the caller it receives.
 */
export function createTools(manager: ChildWindowManager): McpToolDescriptor[] {
  return [
    {
      name: 'list_windows',
      description: 'Lists the tracked child windows with their ids, URLs, titles, and session states.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => textResult(JSON.stringify(manager.listChildren(), null, 2)),
    },
    {
      name: 'open_window',
      description: 'Opens one child window and starts tracking it. Returns the child id.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The address the child window loads.' },
          width: { type: 'integer', description: 'The window width in pixels. Default 900.' },
          height: { type: 'integer', description: 'The window height in pixels. Default 700.' },
          frame: {
            type: 'string',
            enum: [...FRAME_MODES.map((mode) => mode.id)],
            description: 'The window chrome. Default: the frame of the workspace window.',
          },
        },
        required: ['url'],
      },
      handler: async (args, caller) => {
        const url = requireString(args, 'url');
        const id = await manager.openChild(caller, url, {
          width: optionalNumber(args, 'width') ?? 900,
          height: optionalNumber(args, 'height') ?? 700,
          frame: optionalFrame(args),
        });
        return textResult(`Child window ${id} opened for ${url}.`);
      },
    },
    {
      name: 'close_window',
      description: 'Closes one child window and stops tracking it.',
      inputSchema: { type: 'object', properties: { childId: childIdSchema() }, required: ['childId'] },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        await manager.closeChild(caller, id);
        return textResult(`Child window ${id} closed.`);
      },
    },
    {
      name: 'attach_session',
      description: 'Attaches a debug session to one child window and starts the console capture.',
      inputSchema: { type: 'object', properties: { childId: childIdSchema() }, required: ['childId'] },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        await manager.attach(caller, id);
        return textResult(`Debug session attached to child window ${id}.`);
      },
    },
    {
      name: 'detach_session',
      description: 'Detaches the debug session of one child window. Detaching the session of another principal needs a higher access level.',
      inputSchema: { type: 'object', properties: { childId: childIdSchema() }, required: ['childId'] },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        await manager.detach(caller, id);
        return textResult(`Debug session detached from child window ${id}.`);
      },
    },
    {
      name: 'evaluate',
      description: 'Evaluates one JavaScript expression in one child window. Requires an attached session. The permission gate may queue an approval request.',
      inputSchema: {
        type: 'object',
        properties: {
          childId: childIdSchema(),
          expression: { type: 'string', description: 'The JavaScript source to run.' },
        },
        required: ['childId', 'expression'],
      },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        // The page globals ride along: evaluated code reaches the nodewavenMcp API of the main context.
        manager.ensurePageGlobals(id);
        const expression = requireString(args, 'expression');
        const result = await manager.evaluate(caller, id, expression);
        return textResult(JSON.stringify(result));
      },
    },
    {
      name: 'screenshot',
      description: 'Captures one screenshot of a child window as base64 image data. Requires an attached session.',
      inputSchema: {
        type: 'object',
        properties: {
          childId: childIdSchema(),
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'The image format. Default png.' },
        },
        required: ['childId'],
      },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        const format = args['format'] === 'jpeg' ? 'jpeg' : 'png';
        const data = await manager.captureScreenshot(caller, id, format);
        return { content: [{ type: 'image', data, mimeType: `image/${format}` }] };
      },
    },
    {
      name: 'console_entries',
      description:
        'Reads the captured console entries of one child window since the session attach or the last clear. Requires an attached session.',
      inputSchema: { type: 'object', properties: { childId: childIdSchema() }, required: ['childId'] },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        const lines = (await manager.consoleEntries(caller, id)).map(
          (entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${entry.text}`,
        );
        return textResult(lines.length === 0 ? 'The console buffer is empty.' : lines.join('\n'));
      },
    },
    {
      name: 'clear_console',
      description: 'Clears the captured console entries of one child window.',
      inputSchema: { type: 'object', properties: { childId: childIdSchema() }, required: ['childId'] },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        await manager.clearConsole(caller, id);
        return textResult(`Console of child window ${id} cleared.`);
      },
    },
    {
      name: 'navigate',
      description: 'Loads one address in a child window. The permission gate may queue an approval request.',
      inputSchema: {
        type: 'object',
        properties: {
          childId: childIdSchema(),
          url: { type: 'string', description: 'The address to load.' },
        },
        required: ['childId', 'url'],
      },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        const url = requireString(args, 'url');
        await manager.navigate(caller, id, url);
        return textResult(`Child window ${id} navigated to ${url}.`);
      },
    },
    {
      name: 'open_devtools',
      description:
        'Opens the DevTools window of one child window. The DevTools outrank every session and detach the session of the child. The SDK build only.',
      inputSchema: { type: 'object', properties: { childId: childIdSchema() }, required: ['childId'] },
      handler: async (args, caller) => {
        const id = requireNumber(args, 'childId');
        await manager.openDevTools(caller, id);
        return textResult(`DevTools opened for child window ${id}.`);
      },
    },
  ];
}

function readRequestBody(request: NodeHttpRequest): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => {
      body += typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? bodyDecoder.decode(chunk) : String(chunk);
    });
    request.on('end', () => {
      resolve(body);
    });
  });
}

function respondPlainText(response: NodeHttpResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

/** Renders one tool result into one summary line for the session tab. */
function summarizeToolResult(result: McpToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else {
      parts.push(`[${block.mimeType} image]`);
    }
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 240 ? `${joined.slice(0, 237)}…` : joined;
}

/** Reads the JSON object of one result whose only content is one JSON text block, for the session tab viewer. */
function jsonOfResult(result: McpToolResult): unknown {
  const block = result.content[0];
  if (result.content.length !== 1 || !block || block.type !== 'text') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(block.text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers one MCP message.
 *
 * @param message The parsed JSON-RPC message.
 * @param tools The tool descriptors the host offers.
 * @param context The session the message belongs to and the sink that logs it.
 * @returns The reply, or null for a notification. The server answers notifications with no body.
 */
async function dispatchMcpMessage(
  message: unknown,
  tools: readonly McpToolDescriptor[],
  context: McpRequestContext,
): Promise<JsonRpcReply | null> {
  const record = asRecord(message);
  if (!record) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The request is not a JSON-RPC object.' } };
  }
  const method = record['method'];
  const id = record['id'];
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'The message carries no method.' } };
  }
  if (id === undefined) {
    // A message with a method and no id is a notification. The server answers it with no body,
    // and the notification hub hands it to the page callbacks.
    context.sink.clientNotification(context.sessionId, method, record['params']);
    return null;
  }
  const params = asRecord(record['params']);
  if (method === 'initialize') {
    const requested = params?.['protocolVersion'];
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof requested === 'string' ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'nodewavenui-mcp-host', version: '0.1.0' },
        instructions: 'The tools drive the child windows of the NodeWavenUI app through debug sessions. The resources hold the agent documentation: start with harness:///nodewavenui/overview.md.',
      },
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { resources: listHarnessDocs() },
    };
  }
  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }
  if (method === 'resources/read') {
    const uri = params?.['uri'];
    if (typeof uri !== 'string' || uri.length === 0) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'The resource read carries no uri.' } };
    }
    try {
      const text = await readHarnessDoc(uri);
      return {
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri, mimeType: HARNESS_DOC_MIME_TYPE, text }] },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: '2.0', id, error: { code: -32602, message } };
    }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      },
    };
  }
  if (method === 'tools/call') {
    const name = params?.['name'];
    if (typeof name !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'The tool call carries no name.' } };
    }
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `The tool "${name}" is unknown.` } };
    }
    const args = asRecord(params?.['arguments']) ?? {};
    const caller: WindowCaller = { principal: HOST_PRINCIPAL, source: context.sessionId };
    context.sink.toolCall(context.sessionId, name, args);
    let result: McpToolResult;
    try {
      result = await tool.handler(args, caller);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { content: [{ type: 'text', text: message }], isError: true };
    }
    context.sink.toolResult(context.sessionId, name, summarizeToolResult(result), result.isError === true, jsonOfResult(result));
    return { jsonrpc: '2.0', id, result };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `The method "${method}" is unknown.` } };
}

/** Reads one header value, taking the first entry of a list. */
function readHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return null;
}

async function handleMcpRequest(
  request: NodeHttpRequest,
  response: NodeHttpResponse,
  tools: readonly McpToolDescriptor[],
  accessToken: string,
  fallbackSessionId: string,
  sink: McpSessionSink,
  knownSessions: Set<string>,
): Promise<void> {
  try {
    if (request.method !== 'POST') {
      respondPlainText(response, 405, 'The MCP host accepts POST requests only.');
      return;
    }
    const authorization = request.headers['authorization'];
    if (authorization !== `Bearer ${accessToken}`) {
      respondPlainText(response, 401, 'The access token is missing or wrong.');
      return;
    }
    const message = JSON.parse(await readRequestBody(request)) as unknown;
    const headerSession = readHeader(request.headers['mcp-session-id']);
    const method = asRecord(message)?.['method'];
    // A session-opening initialize without a presented session id starts a new session.
    // Every other message without a presented session id lands in the shared fallback session.
    let sessionId: string;
    if (headerSession) {
      sessionId = headerSession;
    } else if (method === 'initialize') {
      sessionId = crypto.randomUUID();
    } else {
      sessionId = fallbackSessionId;
    }
    if (!knownSessions.has(sessionId)) {
      knownSessions.add(sessionId);
      sink.sessionOpened(sessionId);
    }
    const reply = await dispatchMcpMessage(message, tools, { sessionId, sink });
    response.setHeader('Mcp-Session-Id', sessionId);
    if (!reply) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondPlainText(response, 400, message);
  }
}

/**
 * Starts the MCP host and returns its handle for the settings pane.
 * The token comes from the workspace storage. A missing or damaged token is generated and persisted.
 * The log states the endpoint but never the token.
 *
 * @param manager The child window manager the tools drive.
 * @param config The listen configuration.
 * @param tokenStore The token persistence of the workspace.
 * @param sessionSink The sink that logs sessions and tool traffic into the main app.
 * @returns The running host handle.
 * @throws Error when the Node http module is missing or the port does not open.
 */
export async function startMcpHost(
  manager: ChildWindowManager,
  config: McpHostConfig,
  tokenStore: McpHostTokenStore,
  sessionSink: McpSessionSink,
): Promise<McpHostHandle> {
  const httpModule = asRecord(requireNodeModule('http'));
  const createServer = httpModule?.['createServer'];
  if (typeof createServer !== 'function') {
    throw new Error('The MCP host could not start. The Node http module is not available.');
  }
  let accessToken = await tokenStore.loadMcpHostToken();
  if (!accessToken) {
    accessToken = createAccessToken();
    try {
      await tokenStore.saveMcpHostToken(accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the MCP host token could not be saved. A new token is used on each start: ${message}`);
    }
  }
  const token = accessToken;
  const fallbackSessionId = crypto.randomUUID();
  const knownSessions = new Set<string>();
  const tools = createTools(manager);
  const server = (createServer as NodeHttpModule['createServer'])((request, response) => {
    void handleMcpRequest(request, response, tools, token, fallbackSessionId, sessionSink, knownSessions);
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', (error) => {
      reject(error);
    });
    server.listen(config.port, config.interface, () => {
      resolve();
    });
  });
  const endpoint = `http://${config.interface}:${config.port}/mcp`;
  console.info(`[NodeWavenUI] MCP host listens on ${endpoint}. The settings pane shows the access token.`);
  return {
    endpoint,
    readAccessToken: () => token,
  };
}
