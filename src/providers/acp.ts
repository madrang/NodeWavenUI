/**
 * Inference provider that consumes an agent through the Agent Client Protocol (ACP), protocol v1.
 * Protocol reference: https://agentclientprotocol.com .
 * The integration shape for agent CLIs lives in the vault note `Kimi Code/Guides.md`, section 5.
 *
 * ACP is turn-based: the client connects to an agent, opens a session, and sends one prompt per turn.
 * This provider maps the stateless chat message list onto that flow.
 * Each complete() call opens a fresh session and packs the conversation into one prompt text block.
 *
 * Two transports carry the same newline-free JSON-RPC 2.0 messages:
 * a spawned process speaks ACP over stdio with one JSON message per line, and a WebSocket URL speaks ACP over text frames.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { isRecord } from '../shared/records.js';
import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type InferenceProvider,
} from './provider.js';

/** Where to reach an ACP agent. */
export type AcpConnection =
  /** Spawns a local process and speaks ACP over its stdio. */
  | { readonly kind: 'process'; readonly command: string; readonly args?: readonly string[] }
  /** Connects to a WebSocket URL and speaks ACP over text frames. */
  | { readonly kind: 'url'; readonly url: string };

/** Configuration for one ACP agent. */
export interface AcpProviderConfig {
  /** Identifier of this provider instance. The default is "acp". */
  readonly id?: string;
  /** Where to reach the agent. */
  readonly connection: AcpConnection;
  /**
   * Absolute working directory for the ACP session.
   * The default is the current working directory of this process.
   */
  readonly cwd?: string;
}

/**
 * Reads the session id from a session/new response.
 *
 * @param value The response result. It can have any type.
 * @returns The session id.
 * @throws ProviderError when the result carries no session id.
 */
function readSessionId(value: unknown): string {
  if (isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0) {
    return value.sessionId;
  }
  throw new ProviderError('The ACP agent answered session/new without a session id.');
}

/**
 * Reads the stop reason from a session/prompt response.
 *
 * @param value The response result. It can have any type.
 * @returns The stop reason string.
 * @throws ProviderError when the result carries no stop reason.
 */
function readStopReason(value: unknown): string {
  if (isRecord(value) && typeof value.stopReason === 'string') {
    return value.stopReason;
  }
  throw new ProviderError('The ACP agent answered session/prompt without a stop reason.');
}

/**
 * Reads the text out of an agent_message_chunk content field.
 * The chunk content is a content block, an array of blocks, or a plain string, so every shape is accepted.
 *
 * @param content The content field of an agent message chunk.
 * @returns The text of every text block, joined.
 */
function readTextContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  let text = '';
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/**
 * Packs the conversation into one prompt text block.
 * ACP takes one user turn per prompt, so the system messages become a preamble and the past turns become a transcript.
 *
 * @param messages The conversation of the completion request.
 * @returns One text block that carries the whole conversation.
 */
function buildPromptText(messages: readonly ChatMessage[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      sections.push(`System instructions:\n${message.content}`);
    } else if (message.role === 'user') {
      sections.push(`User:\n${message.content}`);
    } else {
      sections.push(`Assistant:\n${message.content}`);
    }
  }
  return sections.join('\n\n');
}

/** One ACP message channel, stdio or WebSocket. */
interface AcpTransport {
  /** Starts the channel. The promise rejects when the channel cannot open. */
  connect(): Promise<void>;
  /** Sends one JSON-RPC message. */
  send(message: unknown): void;
  /** Registers the handler for inbound messages. */
  onMessage(handler: (message: unknown) => void): void;
  /** Registers the handler that fires once when the channel closes or dies. */
  onClose(handler: (error: Error | null) => void): void;
  /** Closes the channel and releases the underlying resource. */
  close(): void;
}

/** Speaks ACP over the stdio of a spawned process. */
class ProcessAcpTransport implements AcpTransport {
  private readonly connection: Extract<AcpConnection, { kind: 'process' }>;
  private child: ChildProcess | null = null;
  private messageHandler: ((message: unknown) => void) | null = null;
  private closeHandler: ((error: Error | null) => void) | null = null;

  constructor(connection: Extract<AcpConnection, { kind: 'process' }>) {
    this.connection = connection;
  }

  /**
   * Spawns the agent process.
   *
   * @throws Error when the process cannot spawn, with the operating system error as the cause.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.connection.command, [...(this.connection.args ?? [])], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.once('error', (error) => {
        reject(new Error(`Could not spawn the ACP process "${this.connection.command}".`, { cause: error }));
      });
      child.once('close', () => {
        this.closeHandler?.(null);
      });
      const stdout = child.stdout;
      if (stdout === null) {
        child.kill();
        reject(new Error(`The ACP process "${this.connection.command}" opened without a stdout pipe.`));
        return;
      }
      stdout.setEncoding('utf8');
      // The ACP stdio transport delimits messages with newlines, and a message must not contain newlines.
      let buffer = '';
      stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          this.deliver(line);
          newline = buffer.indexOf('\n');
        }
      });
      child.once('spawn', () => {
        resolve();
      });
    });
  }

  send(message: unknown): void {
    const stdin = this.child?.stdin ?? null;
    if (stdin !== null) {
      stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error: Error | null) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }

  private deliver(line: string): void {
    if (line.length === 0) {
      return;
    }
    try {
      this.messageHandler?.(JSON.parse(line));
    } catch {
      console.warn('[NodeWavenUI] the ACP process wrote a stdout line that is not JSON.');
    }
  }
}

/** Speaks ACP over the text frames of a WebSocket. */
class WebSocketAcpTransport implements AcpTransport {
  private readonly connection: Extract<AcpConnection, { kind: 'url' }>;
  private socket: WebSocket | null = null;
  private messageHandler: ((message: unknown) => void) | null = null;
  private closeHandler: ((error: Error | null) => void) | null = null;

  constructor(connection: Extract<AcpConnection, { kind: 'url' }>) {
    this.connection = connection;
  }

  /**
   * Opens the WebSocket.
   *
   * @throws Error when the socket cannot open.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.connection.url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error(`Could not open the ACP WebSocket ${this.connection.url}.`));
      });
      // The draft ACP WebSocket transport carries JSON-RPC in text frames and ignores binary frames.
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          return;
        }
        try {
          this.messageHandler?.(JSON.parse(event.data));
        } catch {
          console.warn('[NodeWavenUI] the ACP WebSocket sent a frame that is not JSON.');
        }
      });
      socket.addEventListener('close', () => {
        this.closeHandler?.(null);
      });
    });
  }

  send(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error: Error | null) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/** One pending JSON-RPC call. */
interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** Drives one ACP agent connection: lifecycle, calls, and inbound traffic. */
class AcpAgent {
  private readonly transport: AcpTransport;
  private nextMessageId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private updateListener: ((params: Record<string, unknown>) => void) | null = null;
  /** Name of the agent, from the initialize response. */
  agentName: string | null = null;

  constructor(transport: AcpTransport) {
    this.transport = transport;
  }

  /**
   * Opens the transport and runs the ACP initialize handshake.
   *
   * @throws ProviderError when the transport fails or the agent rejects the handshake.
   */
  async connect(): Promise<void> {
    await this.transport.connect();
    this.transport.onMessage((message) => {
      this.handleMessage(message);
    });
    this.transport.onClose(() => {
      this.failPending();
    });
    try {
      const result = await this.call('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'NodeWavenUI', version: '0.1.0' },
      });
      if (isRecord(result) && isRecord(result.agentInfo) && typeof result.agentInfo.name === 'string') {
        this.agentName = result.agentInfo.name;
      }
      this.notify('initialized', {});
    } catch (error) {
      this.transport.close();
      throw error;
    }
  }

  /**
   * Sends one JSON-RPC request and waits for the answer.
   *
   * @param method The ACP method name.
   * @param params The parameters of the call.
   * @returns The result of the call.
   * @throws ProviderError when the agent answers an error or the connection closes first.
   */
  call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextMessageId;
    this.nextMessageId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Sends one JSON-RPC notification. */
  notify(method: string, params: unknown): void {
    this.transport.send({ jsonrpc: '2.0', method, params });
  }

  /** Sets or clears the listener for session/update notifications. */
  setUpdateListener(listener: ((params: Record<string, unknown>) => void) | null): void {
    this.updateListener = listener;
  }

  /** Closes the connection and fails every pending call. */
  close(): void {
    this.failPending();
    this.transport.close();
  }

  private failPending(): void {
    for (const call of this.pending.values()) {
      call.reject(new ProviderError('The ACP connection closed before the agent answered.'));
    }
    this.pending.clear();
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number') {
        this.handleAgentRequest(message.id, message.method, message.params);
      } else {
        this.handleNotification(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const call = this.pending.get(message.id);
    if (call === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (isRecord(message.error) && typeof message.error.message === 'string') {
      call.reject(new ProviderError(`The ACP agent answered an error for "${message.method ?? message.id}": ${message.error.message}`));
      return;
    }
    call.resolve(message.result);
  }

  private handleAgentRequest(id: number, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      this.answerPermission(id, params);
      return;
    }
    this.transport.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  /**
   * Answers a permission request with the first allow option.
   * When the agent offers no allow option, this client picks the first reject option.
   * This headless default lets an agent run its tools without a permission UI.
   */
  private answerPermission(id: number, params: unknown): void {
    const options = isRecord(params) && Array.isArray(params.options) ? params.options : [];
    const allow = options.find(
      (option) => isRecord(option) && option.kind === 'allow_once' && typeof option.optionId === 'string',
    );
    const reject = options.find(
      (option) => isRecord(option) && option.kind === 'reject_once' && typeof option.optionId === 'string',
    );
    const selected = allow ?? reject;
    if (isRecord(selected) && typeof selected.optionId === 'string') {
      this.transport.send({
        jsonrpc: '2.0',
        id,
        result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
      });
      return;
    }
    this.transport.send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.updateListener === null || !isRecord(params)) {
      return;
    }
    this.updateListener(params);
  }
}

/** Runs inference through one ACP agent. */
export class AcpInferenceProvider implements InferenceProvider {
  readonly id: string;
  private readonly config: AcpProviderConfig;
  private agent: AcpAgent | null = null;

  /**
   * @param config The connection target, the session directory, and an optional instance identifier.
   */
  constructor(config: AcpProviderConfig) {
    this.config = config;
    this.id = config.id ?? 'acp';
  }

  /**
   * Completes a conversation through one ACP session turn.
   *
   * @param request The conversation. The provider ignores the model field, because the agent selects its model through its own configuration.
   * @returns The agent message text and the agent name. Usage counts stay absent, because ACP reports context sizes, not completion tokens.
   * @throws ProviderError when the connection fails, the session cannot open, or the turn ends without the end_turn reason.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const agent = await this.ensureAgent();
    const sessionId = await this.openSession(agent);
    const chunks: string[] = [];
    agent.setUpdateListener((params) => {
      if (params.sessionId !== sessionId || !isRecord(params.update)) {
        return;
      }
      if (params.update.session_update === 'agent_message_chunk') {
        chunks.push(readTextContent(params.update.content));
      }
    });
    try {
      const result: unknown = await agent.call('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: buildPromptText(request.messages) }],
      });
      const stopReason = readStopReason(result);
      if (stopReason !== 'end_turn') {
        throw new ProviderError(`The ACP agent "${this.id}" ended the turn with reason "${stopReason}".`);
      }
    } finally {
      agent.setUpdateListener(null);
    }
    return {
      content: chunks.join(''),
      model: agent.agentName ?? this.id,
    };
  }

  private async ensureAgent(): Promise<AcpAgent> {
    if (this.agent !== null) {
      return this.agent;
    }
    const connection = this.config.connection;
    const transport =
      connection.kind === 'process' ? new ProcessAcpTransport(connection) : new WebSocketAcpTransport(connection);
    const agent = new AcpAgent(transport);
    try {
      await agent.connect();
    } catch (error) {
      agent.close();
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(`Could not connect the ACP agent "${this.id}".`, { cause: error });
    }
    this.agent = agent;
    return agent;
  }

  private async openSession(agent: AcpAgent): Promise<string> {
    try {
      const result: unknown = await agent.call('session/new', {
        cwd: this.config.cwd ?? process.cwd(),
        mcpServers: {},
      });
      return readSessionId(result);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(`The ACP agent "${this.id}" could not open a session.`, { cause: error });
    }
  }
}
