/**
 * The transports of the MCP client: streamable HTTP and stdio.
 * Every message is JSON-RPC 2.0. One request carries one id and waits for the reply with the same id.
 * The client speaks the legacy era: an initialize handshake opens the session, and an HTTP server may
 * mint a session id that every later POST echoes (see the vault note `Projects/Scoped Vault MCP/MCP Standard.md`).
 */

import { asRecord } from '../../shared/records.js';

/** One JSON-RPC reply of a server. */
export interface JsonRpcReply {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Sends JSON-RPC messages to one MCP server. */
export interface McpTransport {
  /** Sends one request and resolves with its result. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Sends one notification. The server answers it with no body. */
  notify(method: string, params?: Record<string, unknown>): void;
  /** Closes the transport and fails every pending request. */
  close(): void;
}

/** Reads one JSON-RPC reply and returns its result or throws its error. */
function settleReply(reply: JsonRpcReply, method: string): unknown {
  if (reply.error !== undefined) {
    throw new Error(`The MCP call "${method}" failed with code ${reply.error.code}: ${reply.error.message}`);
  }
  return reply.result;
}

/** Streams one server-sent-events body and resolves with the first reply that carries the wanted id.
 * Notification messages that share the stream reach the handler. */
async function readEventStreamReply(
  body: ReadableStream<Uint8Array>,
  wantedId: number | string,
  onNotification: (method: string, params: unknown) => void,
): Promise<JsonRpcReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error('The MCP event stream ended before the reply arrived.');
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const reply = asRecord(parsed);
        if (reply === null) {
          continue;
        }
        if (typeof reply.method === 'string' && reply.id === undefined) {
          onNotification(reply.method, reply.params);
          continue;
        }
        if (reply.id === wantedId) {
          return reply as JsonRpcReply;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** The streamable HTTP transport: one POST per message. */
export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly onNotification: (method: string, params: unknown) => void;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(url: string, token?: string, onNotification: (method: string, params: unknown) => void = () => {}) {
    this.url = url;
    this.token = token;
    this.onNotification = onNotification;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const reply = await this.post({ jsonrpc: '2.0', id, method, params: params ?? {} });
    return settleReply(reply, method);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    void this.post({ jsonrpc: '2.0', method, params: params ?? {} }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the MCP notification "${method}" failed: ${message}`);
    });
  }

  private async post(message: Record<string, unknown>): Promise<JsonRpcReply> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.token !== undefined && this.token.length > 0) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.sessionId !== null) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader !== null && sessionHeader.length > 0) {
      this.sessionId = sessionHeader;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.length > 0 ? ` ${detail.slice(0, 200)}` : '';
      throw new Error(`The MCP endpoint answered HTTP ${response.status}.${suffix}`);
    }
    if (message.id === undefined) {
      return {};
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (response.body !== null && contentType.includes('text/event-stream')) {
      return readEventStreamReply(response.body, message.id as number | string, this.onNotification);
    }
    const payload: unknown = await response.json().catch(() => null);
    const reply = asRecord(payload);
    if (reply === null) {
      throw new Error('The MCP endpoint returned a body that is not JSON-RPC.');
    }
    return reply as JsonRpcReply;
  }

  close(): void {
    // HTTP keeps no connection open between calls.
  }
}

/** The slice of the Node child_process module the stdio transport uses. */
interface NodeChildProcessModule {
  spawn(command: string, args: readonly string[], options: { readonly stdio: readonly string[] }): NodeChild;
}

interface NodeChildStream {
  setEncoding(encoding: string): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  write(text: string): boolean;
  end(): unknown;
}

interface NodeChild {
  readonly stdin: NodeChildStream | null;
  readonly stdout: NodeChildStream | null;
  readonly stderr: NodeChildStream | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

interface PendingCall {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** The stdio transport: one spawned subprocess, newline-delimited JSON-RPC on stdin and stdout. */
export class StdioMcpTransport implements McpTransport {
  private child: NodeChild | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly onNotification: (method: string, params: unknown) => void;
  private closed = false;

  /**
   * @param command The executable to spawn.
   * @param args The arguments of the executable.
   * @param onNotification Receives the notifications the server writes between the replies.
   * @throws Error when the Node child_process module is missing or the process does not start.
   */
  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
    onNotification: (method: string, params: unknown) => void = () => {},
  ) {
    this.onNotification = onNotification;
  }

  private async ensureChild(): Promise<NodeChild> {
    if (this.child !== null) {
      return this.child;
    }
    if (this.closed) {
      throw new Error('The MCP stdio transport is closed.');
    }
    // The Node require global reads the module lazily, because the renderer may run without Node.
    const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof nodeRequire !== 'function') {
      throw new Error('The MCP stdio transport needs the Node require global. It is unavailable in this context.');
    }
    let raw: unknown;
    try {
      raw = nodeRequire('child_process');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`The Node child_process module could not load: ${message}`);
    }
    const record = asRecord(raw);
    if (record === null || typeof record.spawn !== 'function') {
      throw new Error('The Node child_process module carries no spawn function.');
    }
    const spawn = record.spawn as NodeChildProcessModule['spawn'];
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.once('error', (error: Error) => {
        reject(new Error(`The MCP stdio process "${this.command}" did not start: ${error.message}`));
      });
      child.once('spawn', () => {
        resolve();
      });
    });
    this.child = child;
    child.once('close', () => {
      this.failPending('The MCP stdio process closed before the reply arrived.');
    });
    const stdout = child.stdout;
    if (stdout === null) {
      throw new Error('The MCP stdio process carries no stdout pipe.');
    }
    stdout.setEncoding('utf8');
    let buffer = '';
    stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) {
          continue;
        }
        this.handleLine(line);
      }
    });
    const stderr = child.stderr;
    if (stderr !== null) {
      stderr.setEncoding('utf8');
      stderr.on('data', () => {
        // stderr is free for server logging. It never carries MCP messages.
      });
    }
    return child;
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[NodeWavenUI] the MCP stdio process wrote one line that is not JSON. It is skipped.');
      return;
    }
    const record = asRecord(parsed);
    if (record === null) {
      return;
    }
    const id = record.id;
    if (record.result !== undefined || record.error !== undefined) {
      if (typeof id === 'number') {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(id);
        if (record.error !== undefined) {
          const error = asRecord(record.error);
          const code = error !== null && typeof error.code === 'number' ? error.code : -32603;
          const message = error !== null && typeof error.message === 'string' ? error.message : 'unknown error';
          pending.reject(new Error(`The MCP stdio call failed with code ${code}: ${message}`));
        } else {
          pending.resolve(record.result);
        }
      }
      return;
    }
    if (typeof id === 'number' || typeof id === 'string') {
      // A server request earns the unknown-method error, because the client requests nothing from the server.
      const reply = { jsonrpc: '2.0', id, error: { code: -32601, message: 'The MCP client answers no server requests.' } };
      this.writeLine(JSON.stringify(reply));
      return;
    }
    if (typeof record.method === 'string') {
      this.onNotification(record.method, record.params);
    }
  }

  private writeLine(text: string): void {
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined) {
      return;
    }
    stdin.write(`${text}\n`);
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureChild();
    const id = this.nextId;
    this.nextId += 1;
    const child = this.child;
    if (child === null) {
      throw new Error('The MCP stdio transport did not start.');
    }
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
    });
    return result;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.child === null) {
      return;
    }
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }));
  }

  close(): void {
    this.closed = true;
    this.failPending('The MCP stdio transport closed.');
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }
}
