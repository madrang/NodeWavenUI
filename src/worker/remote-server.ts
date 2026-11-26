/**
 * The remote control server of the worker core: the phone page and its API. Every data request
 * needs a credential, either the pairing token or a session that a password login minted, and
 * the login slows down and locks out repeated wrong answers. The server answers HTTPS with a
 * self-signed certificate by default, and a setting allows bare HTTP. The pairing QR carries the
 * address and the token in the URL fragment, so no credential ever lands in a request line.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { createReadStream } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { RemoteServerConfig, WorkspaceSettingsStore } from '../storage/settings-store.js';
import { WORKSPACE_REMOTE_FOLDER } from '../shared/workspace.js';
import type {
  CoreChatPicks,
  CoreConnectionMenu,
  CoreSystemPrompt,
  CoreSystemPromptSourceInfo,
} from '../shared/core-api.js';
import { BodyLimitError, readRequestBody } from '../shared/http-body.js';
import { readSystemPromptIds } from '../shared/system-prompts.js';
import { log } from './logger.js';

/** Generates the self-signed certificate of the remote server. */
type CertificateGenerator = (addresses: readonly string[]) => Promise<{ cert: string; key: string }>;

/** Builds the pairing QR code image of one address. */
type QrBuilder = (text: string) => Promise<string>;

/** One chat session in the shape the phone page reads. The id is the session file id. */
export interface RemoteChatSession {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly entries: readonly unknown[];
  /** The system prompt the chat bound on its first send, when it sent one. */
  readonly systemPrompt?: CoreSystemPrompt;
  /** The draft task the chat waits for. Its first send dispatches the task into the chat. */
  readonly waitingTaskId?: string;
  /** The provider account and the model the chat bound on its first send, when it sent one. */
  readonly boundProviderId?: string;
  readonly boundModel?: string;
}

/** The state the server serves: the same snapshots every surface sees. */
export interface RemoteStateProviders {
  /** The display name of the workspace. Empty keeps the app name on the page. */
  workspaceName(): string;
  permission(): { pending: readonly unknown[]; rules: readonly unknown[] };
  patches(): { patches: readonly unknown[]; tasks: readonly unknown[] };
  tasks(): { records: readonly unknown[] };
  /** Every chat of the engine in creation order: the stored sessions and the fresh chats that hold
   * no file yet. */
  chatSessions(): Promise<readonly RemoteChatSession[]>;
  /** Opens one fresh chat in the engine. Its session file lands with its first message. A task id
   * names the draft task the chat waits for. */
  createChat(taskId?: string): RemoteChatSession;
  /** Lists the system prompt sources a first send binds, in menu order. The engine reads the folder of
   * the prompt files on every call. */
  chatPromptSources(): Promise<readonly CoreSystemPromptSourceInfo[]>;
  /** The connection menu a first send picks from. No key and no address ride along. */
  chatConnections(): Promise<CoreConnectionMenu>;
  resolvePermission(id: number, approve: boolean, remember: boolean): Promise<void>;
  applyPatch(id: number): Promise<unknown>;
  denyPatch(id: number, comment: string | null): Promise<void>;
  dismissPatch(id: number): Promise<void>;
  acceptTask(id: string): Promise<unknown>;
  returnTask(id: string): Promise<unknown>;
  cancelTask(id: string): Promise<unknown>;
  /** Lands one message in the chat of the session file. The picks reach a first send: the provider,
   * the model, and the system prompt sources. A missing pick keeps the default of the workspace. */
  sendChat(fileId: string | null, text: string, picks?: CoreChatPicks): void;
  /** Closes the chat of the session file, the way the close of a tab does. An unknown id closes nothing. */
  closeChat(fileId: string): void;
}

/** One open event stream of the remote control. */
interface EventStream {
  readonly write: (chunk: string) => void;
  /** Ends the stream: stops its heartbeat and closes the response. */
  readonly end: () => void;
}

/** The login failures of one remote address, with the lockout its count triggers. */
interface AddressFailures {
  failures: number;
  lockedUntil: number;
}

/** The scrypt parameters of the password digest. */
const SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1 } as const;

/** The byte length of the pairing token and of the session ids. */
const TOKEN_BYTES = 32;

/** How long one login session stays valid. */
const SESSION_MILLISECONDS = 12 * 60 * 60 * 1000;

/** The lockout window after repeated failed logins, and the failure count that triggers it. */
const LOCKOUT_MILLISECONDS = 5 * 60 * 1000;
const LOCKOUT_FAILURES = 10;

/** The content types the static files of the phone page map to. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** The shape of the stored password digest record. */
interface PasswordRecord {
  readonly v: 1;
  readonly salt: string;
  readonly digest: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

/** Reads the LAN addresses the certificate lists, every non-internal IPv4 address of the host. */
function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/** Owns the remote control server of one workspace. */
export class RemoteServer {
  private readonly store: WorkspaceSettingsStore;
  private readonly workspacePath: string;
  private readonly appRoot: string;
  private readonly state: RemoteStateProviders;
  private readonly generateCertificate: CertificateGenerator;
  private readonly buildQr: QrBuilder;
  private server: Server | null = null;
  private token = '';
  private config: RemoteServerConfig | null = null;
  private readonly sessions = new Map<string, number>();
  private readonly failuresByAddress = new Map<string, AddressFailures>();
  private readonly streams = new Set<EventStream>();

  /**
   * @param store The settings store of the workspace.
   * @param workspacePath The workspace folder, where the certificate persists.
   * @param appRoot The app root, where the phone page assets sit.
   * @param state The state providers and actions of the worker core.
   * @param generateCertificate Generates the self-signed certificate (injected for testing).
   * @param buildQr Builds the pairing QR image (injected for testing).
   */
  constructor(
    store: WorkspaceSettingsStore,
    workspacePath: string,
    appRoot: string,
    state: RemoteStateProviders,
    generateCertificate: CertificateGenerator,
    buildQr: QrBuilder,
  ) {
    this.store = store;
    this.workspacePath = workspacePath;
    this.appRoot = appRoot;
    this.state = state;
    this.generateCertificate = generateCertificate;
    this.buildQr = buildQr;
  }

  /** Reads the running configuration, or null while the server stays off. */
  currentConfig(): RemoteServerConfig | null {
    return this.config;
  }

  /** Reads the LAN address the pairing address uses: the bound interface when one is picked,
   * else the first non-internal IPv4 address. */
  private lanAddress(): string {
    const bind = this.config?.bind;
    if (bind && bind !== '0.0.0.0') {
      return bind;
    }
    return lanAddresses()[0] ?? '127.0.0.1';
  }

  /** Reads the addresses the server may bind: every interface, then each LAN address, then the
   * loopback. The settings section offers the list, and a save validates its pick against it. */
  bindableAddresses(): readonly string[] {
    return [...new Set(['0.0.0.0', ...lanAddresses(), '127.0.0.1'])];
  }

  /** Reads the origin the phone connects to. */
  origin(): string {
    const config = this.config;
    const scheme = config?.allowPlainHttp ? 'http' : 'https';
    return `${scheme}://${this.lanAddress()}:${String(config?.port ?? 9777)}`;
  }

  /** Reads or creates the pairing token. */
  private async ensureToken(): Promise<string> {
    const stored = await this.store.loadRemoteToken();
    if (stored) {
      this.token = stored;
      return stored;
    }
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await this.store.saveRemoteToken(token);
    this.token = token;
    return token;
  }

  /** Reads the certificate of the workspace, or generates and stores one when the addresses changed. */
  private async certificate(): Promise<{ cert: string; key: string } | null> {
    const folder = join(this.workspacePath, WORKSPACE_REMOTE_FOLDER);
    const certPath = join(folder, 'cert.pem');
    const keyPath = join(folder, 'key.pem');
    const metaPath = join(folder, 'addresses.json');
    const addresses = lanAddresses();
    try {
      if (existsSync(certPath) && existsSync(keyPath) && existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { addresses?: unknown };
        if (JSON.stringify(meta.addresses) === JSON.stringify(addresses)) {
          return { cert: readFileSync(certPath, 'utf-8'), key: readFileSync(keyPath, 'utf-8') };
        }
      }
      const generated = await this.generateCertificate(addresses);
      // The folder holds the private key, so it stays closed to the other users of the host.
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(certPath, generated.cert);
      writeFileSync(keyPath, generated.key, { mode: 0o600 });
      writeFileSync(metaPath, `${JSON.stringify({ addresses }, null, 2)}\n`);
      log.worker.notice('the remote certificate was regenerated for the current addresses.');
      return generated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.worker.warning(`the remote certificate could not be prepared: ${message}`);
      return null;
    }
  }

  /**
   * Applies one configuration and restarts the server when it runs.
   *
   * @param config The configuration to apply.
   */
  async configure(config: RemoteServerConfig): Promise<void> {
    await this.store.saveRemoteServerConfig(config);
    this.stop();
    if (config.enabled) {
      await this.start(config);
    }
  }

  /**
   * Starts the server under one configuration.
   *
   * @param config The configuration to run under.
   * @returns The origin the phone connects to, or null when the server could not start.
   */
  async start(config: RemoteServerConfig): Promise<string | null> {
    if (this.server) {
      return this.origin();
    }
    await this.ensureToken();
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response).catch((error: unknown) => {
        if (error instanceof BodyLimitError && !response.destroyed) {
          // The unread rest of the body rides the socket after the refusal; the destroy on the
          // flush closes it.
          log.worker.warning(`the remote request "${request.url}" was refused: ${error.text}`);
          response.once('finish', () => {
            request.destroy();
          });
          response.writeHead(error.status, { 'content-type': 'text/plain' });
          response.end(error.text);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.worker.warning(`the remote request "${request.url}" failed: ${message}`);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain' });
        }
        response.end('The remote request failed.');
      });
    };
    let server: Server;
    if (config.allowPlainHttp) {
      server = createHttpServer(handler);
    } else {
      const certificate = await this.certificate();
      if (!certificate) {
        log.worker.error('the remote server needs a certificate. Allow plain HTTP or check the workspace folder.');
        return null;
      }
      server = createHttpsServer({ cert: certificate.cert, key: certificate.key }, handler);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.bind, () => {
        resolve();
      });
    });
    this.server = server;
    this.config = config;
    log.worker.notice(`the remote control answers on ${this.origin()}`);
    return this.origin();
  }

  /** Stops the server, ends every event stream, and drops every login session. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.config = null;
    this.sessions.clear();
    for (const stream of this.streams) {
      stream.end();
    }
    this.streams.clear();
  }

  /** Pushes one event to every open stream of the phone pages. */
  broadcast(channel: string, payload: unknown): void {
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const stream of this.streams) {
      stream.write(frame);
    }
  }

  /** Builds the pairing QR image of the current address and token. */
  async pairingQr(): Promise<string> {
    return this.buildQr(`${this.origin()}/#token=${this.token}`);
  }

  /** Renews the pairing token. Every open phone page re-pairs with the new token. */
  async renewToken(): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await this.store.saveRemoteToken(token);
    this.token = token;
    return token;
  }

  /** Reads the pairing token for the settings pane. */
  readToken(): string {
    return this.token;
  }

  /**
   * Sets the remote password. The record holds a digest with a fresh salt, never the password.
   *
   * @param password The password to set.
   */
  async setPassword(password: string): Promise<void> {
    const salt = randomBytes(16);
    const digest = scryptSync(password, salt, 32, SCRYPT_PARAMETERS);
    const record: PasswordRecord = {
      v: 1,
      salt: salt.toString('hex'),
      digest: digest.toString('hex'),
      n: SCRYPT_PARAMETERS.N,
      r: SCRYPT_PARAMETERS.r,
      p: SCRYPT_PARAMETERS.p,
    };
    await this.store.saveRemoteAuth(JSON.stringify(record));
  }

  /** Removes the remote password. The token stays the only credential. */
  async clearPassword(): Promise<void> {
    await this.store.saveRemoteAuth('');
  }

  /** Checks one request credential. True when the token or a live session matches. */
  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return false;
    }
    const presented = header.slice('Bearer '.length);
    if (presented.length === this.token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(this.token))) {
      return true;
    }
    const expiry = this.sessions.get(presented);
    if (expiry && expiry > Date.now()) {
      return true;
    }
    return false;
  }

  /** Answers one login attempt with a session id, a token confirmation, or a failure. The lockout
   * counts per remote address, so one guessing address locks itself out alone. */
  private async login(body: unknown, address: string): Promise<{ ok: boolean; session?: string }> {
    const now = Date.now();
    const failures = this.failuresByAddress.get(address) ?? { failures: 0, lockedUntil: 0 };
    if (now < failures.lockedUntil) {
      return { ok: false };
    }
    const candidate = body as { token?: unknown; password?: unknown } | null;
    if (typeof candidate?.token === 'string') {
      const presented = Buffer.from(candidate.token);
      if (candidate.token.length === this.token.length && timingSafeEqual(presented, Buffer.from(this.token))) {
        return { ok: true, session: this.token };
      }
    }
    if (typeof candidate?.password === 'string') {
      // The growing delay of the wrong answers slows every guess down, logged in or not.
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(failures.failures * 200, 2000));
      });
      const raw = await this.store.loadRemoteAuth();
      if (raw) {
        try {
          const record = JSON.parse(raw) as PasswordRecord;
          const digest = scryptSync(candidate.password, Buffer.from(record.salt, 'hex'), 32, {
            N: record.n,
            r: record.r,
            p: record.p,
          });
          const stored = Buffer.from(record.digest, 'hex');
          if (digest.length === stored.length && timingSafeEqual(digest, stored)) {
            this.failuresByAddress.delete(address);
            const session = randomBytes(TOKEN_BYTES).toString('hex');
            this.sweepSessions(now);
            this.sessions.set(session, now + SESSION_MILLISECONDS);
            return { ok: true, session };
          }
        } catch {
          // A damaged record refuses every password.
        }
      }
    }
    failures.failures += 1;
    if (failures.failures >= LOCKOUT_FAILURES) {
      failures.lockedUntil = now + LOCKOUT_MILLISECONDS;
      failures.failures = 0;
      log.worker.warning(`the remote login from ${address} locked out for repeated wrong credentials.`);
    }
    this.failuresByAddress.set(address, failures);
    return { ok: false };
  }

  /** Drops the expired login sessions, so the map holds only the live ones. */
  private sweepSessions(now: number): void {
    for (const [session, expiry] of this.sessions) {
      if (expiry <= now) {
        this.sessions.delete(session);
      }
    }
  }

  /** Reads the body of one request as parsed JSON, with a size cap. An empty body reads as null. */
  private async readBody(request: IncomingMessage): Promise<unknown> {
    const text = await readRequestBody(request, 1_000_000);
    return text.length === 0 ? null : JSON.parse(text);
  }

  /** Serves one static file of the phone page. The `text`, `chat-cards`, `libs`, and `themes`
   * folders of the renderer build join the page folder, with the json-viewer element module, so
   * the phone carries the text stack, the chat cards, Prism, and the default theme like the app.
   * The system prompt module of the shared build joins the same way, with the harness document
   * module it reads: the setup card shapes its prompt selectors with the helpers of the app. */
  private serveStatic(urlPath: string, response: ServerResponse): boolean {
    const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const base = join(this.appRoot, 'dist', 'renderer', 'remote');
    const shared =
      relative.startsWith('text/') ||
      relative.startsWith('chat-cards/') ||
      relative.startsWith('libs/') ||
      relative.startsWith('themes/') ||
      relative === 'json-viewer-element.js';
    const core = relative === 'shared/system-prompts.js' || relative === 'shared/harness-docs.js';
    const root = core ? join(this.appRoot, 'dist') : shared ? join(this.appRoot, 'dist', 'renderer') : base;
    const resolved = normalize(join(root, relative));
    if (!resolved.startsWith(`${root}/`) || !existsSync(resolved)) {
      return false;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
      'x-content-type-options': 'nosniff',
    });
    createReadStream(resolved).pipe(response);
    return true;
  }

  /** Handles one request of the phone page or its API. */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://remote.local');
    const path = url.pathname;
    if (request.method === 'GET' && !path.startsWith('/api/')) {
      if (this.serveStatic(path, response)) {
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found.');
      return;
    }
    if (request.method === 'POST' && path === '/api/auth') {
      const answer = await this.login(await this.readBody(request), request.socket.remoteAddress ?? '');
      response.writeHead(answer.ok ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
      return;
    }
    if (!this.authorized(request)) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('A credential is needed.');
      return;
    }
    if (request.method === 'GET' && path === '/api/state') {
      // The folder of the prompt files reads before the head of the response, so a read error answers 500.
      const prompts = await this.state.chatPromptSources();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          name: this.state.workspaceName(),
          prompts,
          permission: this.state.permission(),
          patches: this.state.patches(),
          tasks: this.state.tasks(),
        }),
      );
      return;
    }
    if (request.method === 'GET' && path === '/api/chat/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(await this.state.chatSessions()));
      return;
    }
    if (request.method === 'GET' && path === '/api/chat/connections') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(await this.state.chatConnections()));
      return;
    }
    if (request.method === 'GET' && path === '/api/events') {
      // The folder of the prompt files reads before the head of the response, so a read error answers 500.
      const prompts = await this.state.chatPromptSources();
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write('retry: 3000\n\n');
      response.write(`event: state\ndata: ${JSON.stringify({
        name: this.state.workspaceName(),
        prompts,
        permission: this.state.permission(),
        patches: this.state.patches(),
        tasks: this.state.tasks(),
      })}\n\n`);
      const heartbeat = setInterval(() => {
        response.write(':heartbeat\n\n');
      }, 20_000);
      const stream: EventStream = {
        write: (chunk) => {
          response.write(chunk);
        },
        end: () => {
          clearInterval(heartbeat);
          response.end();
        },
      };
      this.streams.add(stream);
      request.on('close', () => {
        stream.end();
        this.streams.delete(stream);
      });
      return;
    }
    if (request.method === 'POST') {
      const body = await this.readBody(request);
      const call = (body ?? {}) as Record<string, unknown>;
      const numericId = (callName: string): number => {
        if (typeof call.id !== 'number') {
          throw new Error(`The ${callName} needs a numeric id.`);
        }
        return call.id;
      };
      const textId = (callName: string): string => {
        if (typeof call.id !== 'string' || call.id.length === 0) {
          throw new Error(`The ${callName} needs a text id.`);
        }
        return call.id;
      };
      // The picks of a first send ride as strings. A value of another shape, or an empty one, stays out.
      const stringPicks = (names: readonly string[]): Record<string, string> => {
        const picks: Record<string, string> = {};
        for (const name of names) {
          const value = call[name];
          if (typeof value === 'string' && value) {
            picks[name] = value;
          }
        }
        return picks;
      };
      if (path === '/api/permission/resolve') {
        await this.state.resolvePermission(numericId('resolve call'), call.approve === true, call.remember === true);
        this.answerJson(response, { ok: true });
        return;
      }
      if (path === '/api/patch/apply') {
        this.answerJson(response, { state: await this.state.applyPatch(numericId('apply call')) });
        return;
      }
      if (path === '/api/patch/deny') {
        await this.state.denyPatch(numericId('deny call'), typeof call.comment === 'string' ? call.comment : null);
        this.answerJson(response, { ok: true });
        return;
      }
      if (path === '/api/patch/dismiss') {
        await this.state.dismissPatch(numericId('dismiss call'));
        this.answerJson(response, { ok: true });
        return;
      }
      if (path === '/api/task/accept' || path === '/api/task/return' || path === '/api/task/cancel') {
        const id = textId('settle call');
        if (path === '/api/task/accept') {
          await this.state.acceptTask(id);
        } else if (path === '/api/task/return') {
          await this.state.returnTask(id);
        } else {
          await this.state.cancelTask(id);
        }
        this.answerJson(response, { ok: true });
        return;
      }
      if (path === '/api/chat/create') {
        this.answerJson(response, this.state.createChat(typeof call.taskId === 'string' ? call.taskId : undefined));
        return;
      }
      if (path === '/api/chat/send') {
        const text = call.text;
        // An empty text sends on a chat that waits for a task: the brief of the task is its message.
        if (typeof text !== 'string') {
          throw new Error('The send call needs a text.');
        }
        // The picks reach a first send. A missing one keeps the default of the workspace.
        // The system prompt pick is the list of the source ids: an empty list is the none pick, and a
        // list that holds no string reads as no pick.
        const systemPromptIds = readSystemPromptIds(call.systemPromptIds);
        this.state.sendChat(
          typeof call.fileId === 'string' ? call.fileId : null,
          text,
          { ...stringPicks(['providerId', 'model']), ...(systemPromptIds ? { systemPromptIds } : {}) },
        );
        this.answerJson(response, { ok: true });
        return;
      }
      if (path === '/api/chat/close') {
        const fileId = call.fileId;
        if (typeof fileId !== 'string' || fileId.length === 0) {
          throw new Error('The close call needs a session file id.');
        }
        this.state.closeChat(fileId);
        this.answerJson(response, { ok: true });
        return;
      }
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found.');
  }

  /** Answers one JSON body. */
  private answerJson(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}
