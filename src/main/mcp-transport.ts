/**
 * The transports of the MCP client: streamable HTTP and stdio.
 * Every message is JSON-RPC 2.0. One request carries one id and waits for the reply with the same id.
 * The client speaks the legacy era: an initialize handshake opens the session, and an HTTP server may
 * mint a session id that every later POST echoes (see the vault note `Projects/Scoped Vault MCP/MCP Standard.md`).
 */

import { spawn } from 'node:child_process';
import { asRecord } from '../shared/records.js';
import { PendingCalls } from '../shared/pending-calls.js';

/** One JSON-RPC reply of a server. */
export interface JsonRpcReply {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; message: string };
}

/** The cap of the initialize handshake. A hung server must not pin its endpoint at connecting. */
export const MCP_HANDSHAKE_TIMEOUT_MS = 30_000;

/** The cap of one request reply wait. The cap stays high, because a tool call may wait on a slow
 * backend of its server, the way one inference call needs its minutes. */
export const MCP_REQUEST_TIMEOUT_MS = 300_000;

/** A connect-class failure: a network fault, a timeout, or a stream that ended before the reply.
 * A connect retry may repeat it, because the server ran nothing. A server-answered error — an
 * HTTP status or a JSON-RPC error reply — is a plain Error instead, and no retry repeats it. */
export class McpNetworkError extends Error {}

/** Sends JSON-RPC messages to one MCP server. */
export interface McpTransport {
  /** Sends one request and resolves with its result. The timeout cap defaults to the request cap. */
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Sends one notification. The server answers it with no body. */
  notify(method: string, params?: Record<string, unknown>): void;
  /** Closes the transport and fails every pending request. */
  close(): void;
}

/** Reads one JSON-RPC reply and returns its result or throws its error. */
function settleReply(reply: JsonRpcReply, method: string): unknown {
  if (reply.error) {
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
        throw new McpNetworkError('The MCP event stream ended before the reply arrived.');
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
        if (!reply) {
          continue;
        }
        if (typeof reply.method === 'string' && !Object.hasOwn(reply, 'id')) {
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
  /** The abort controllers of the in-flight posts, so close() cancels them. */
  private readonly live = new Set<AbortController>();
  private closed = false;
  /** The recovery the owner installs: it re-runs the initialize handshake after a session loss. */
  private recover: (() => Promise<void>) | null = null;
  /** The running recovery, so concurrent losses share one handshake. */
  private recovery: Promise<void> | null = null;

  constructor(url: string, token?: string, onNotification: (method: string, params: unknown) => void = () => {}) {
    this.url = url;
    this.token = token;
    this.onNotification = onNotification;
  }

  /** Installs the session-loss recovery: a 404 on a held session runs it once, then replays. */
  recoverSessions(reinitialize: () => Promise<void>): void {
    this.recover = reinitialize;
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = MCP_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const reply = await this.post({ jsonrpc: '2.0', id, method, params: params ?? {} }, timeoutMs);
    return settleReply(reply, method);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    void this.post({ jsonrpc: '2.0', method, params: params ?? {} }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the MCP notification "${method}" failed: ${message}`);
    });
  }

  private async post(
    message: Record<string, unknown>,
    timeoutMs = MCP_REQUEST_TIMEOUT_MS,
    replay = true,
  ): Promise<JsonRpcReply> {
    if (this.closed) {
      throw new McpNetworkError('The MCP HTTP transport is closed.');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    const controller = new AbortController();
    this.live.add(controller);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new McpNetworkError('The MCP HTTP transport closed before the reply arrived.');
      }
      throw new McpNetworkError(`The MCP endpoint "${this.url}" did not answer: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.live.delete(controller);
    }
    // A 404 on a held session names a lost session: the server restarted or evicted it. One
    // recovery handshake runs, then the message replays once on the fresh session.
    if (response.status === 404 && replay && this.sessionId && this.recover && Object.hasOwn(message, 'id')) {
      const rerun = this.recovery ?? (async () => {
        try {
          this.sessionId = null;
          await this.recover?.();
        } finally {
          this.recovery = null;
        }
      })();
      this.recovery = rerun;
      await rerun;
      return this.post(message, timeoutMs, false);
    }
    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) {
      this.sessionId = sessionHeader;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.length > 0 ? ` ${detail.slice(0, 200)}` : '';
      throw new Error(`The MCP endpoint answered HTTP ${response.status}.${suffix}`);
    }
    if (!message.id) {
      return {};
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (response.body && contentType.includes('text/event-stream')) {
      return readEventStreamReply(response.body, message.id as number | string, this.onNotification);
    }
    const payload: unknown = await response.json().catch(() => null);
    const reply = asRecord(payload);
    if (!reply) {
      throw new Error('The MCP endpoint returned a body that is not JSON-RPC.');
    }
    return reply as JsonRpcReply;
  }

  close(): void {
    this.closed = true;
    for (const controller of this.live) {
      controller.abort();
    }
    this.live.clear();
  }
}

interface NodeChildStream {
  setEncoding(encoding: string): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
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

/** The stdio transport: one spawned subprocess, newline-delimited JSON-RPC on stdin and stdout. */
export class StdioMcpTransport implements McpTransport {
  private child: NodeChild | null = null;
  private readonly pending = new PendingCalls();
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
    if (this.child) {
      return this.child;
    }
    if (this.closed) {
      throw new Error('The MCP stdio transport is closed.');
    }
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as NodeChild;
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
      // The dead child leaves, so a later request spawns a fresh process instead of writing
      // into the dead stdin and waiting forever.
      this.child = null;
    });
    if (child.stdin) {
      // A dead child answers a late write with EPIPE. The reply wait fails through the close
      // handler, so the write error itself needs no crash of the host process.
      child.stdin.on('error', () => {});
    }
    const stdout = child.stdout;
    if (!stdout) {
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
    if (stderr) {
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
    if (!record) {
      return;
    }
    const id = record.id;
    if (Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error')) {
      if (typeof id === 'number') {
        if (!this.pending.has(id)) {
          return;
        }
        if (record.error) {
          const error = asRecord(record.error);
          const code = error && typeof error.code === 'number' ? error.code : -32603;
          const message = error && typeof error.message === 'string' ? error.message : 'unknown error';
          this.pending.reject(id, new Error(`The MCP stdio call failed with code ${code}: ${message}`));
        } else {
          this.pending.resolve(id, record.result);
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
    if (!stdin) {
      return;
    }
    stdin.write(`${text}\n`);
  }

  private failPending(reason: string): void {
    this.pending.rejectAll(() => new McpNetworkError(reason));
  }

  /** Sends one request and waits for the reply under its cap. The cap drops the waiting entry, so
   * a late reply of a silent server resolves nothing. */
  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = MCP_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    await this.ensureChild();
    if (!this.child) {
      throw new Error('The MCP stdio transport did not start.');
    }
    const { id, promise } = this.pending.open(
      timeoutMs,
      () => new McpNetworkError(`The MCP stdio call "${method}" timed out after ${timeoutMs} ms.`),
    );
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
    return promise;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child) {
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
