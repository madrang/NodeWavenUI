/**
 * The child window session service of the main process. It owns the child windows, their debug
 * sessions, and the console capture. Every mutating call runs through the permission check of
 * the workspace page, so the user stays the gate. Electron attaches the debugger per web
 * contents, so no target matching by URL exists and two children with the same address stay
 * apart.
 */

import { BrowserWindow, type WebContents } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callWorkspace, pushWorkspace, setWorkspaceContents } from './workspace-link.js';

/** The app root, one level above the compiled main directory. */
const APP_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, ''));

/** The size a child window opens with when the caller gives none. */
const DEFAULT_CHILD_SIZE = { width: 900, height: 700 } as const;

/** How many console lines one session buffers. */
const CONSOLE_BUFFER_LIMIT = 500;

/** The caller of one session service call, mirroring the renderer principal model. */
export interface WindowCaller {
  readonly principal: string;
  readonly source?: string;
  readonly preauthorized?: boolean;
}

/** One captured console line or exception of a debug session. */
export interface ConsoleEntry {
  readonly kind: 'log' | 'error';
  readonly text: string;
  readonly at: string;
}

/** The public view of one tracked child. */
export interface ChildWindowInfo {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly attached: boolean;
  readonly kind: 'window' | 'iframe' | 'webview';
  readonly shared?: boolean;
}

/** The normalized result of one evaluation. */
export interface EvaluateResult {
  readonly type: string;
  readonly value?: unknown;
  readonly description?: string | null;
}

/** One active debug session. */
interface DebugSession {
  readonly contentsId: number;
  readonly owner: string;
  readonly consoleEntries: ConsoleEntry[];
}

/** The record of one tracked child. An iframe frame owns no web contents of its own. */
interface ChildRecord {
  readonly id: number;
  contents: WebContents | null;
  readonly kind: 'window' | 'iframe' | 'webview';
  url: string;
  title: string;
  /** Present on webview frames: true while the title bar share switch allows debug sessions. */
  shared: boolean;
  session: DebugSession | null;
}

/** The build request the workspace page serves for one new frame. */
export interface FrameBuildRequest {
  readonly id: number;
  readonly kind: 'iframe' | 'webview';
  readonly url: string;
  readonly title: string;
  readonly side: 'left' | 'right';
}

/** The frame command the workspace page serves for one tracked frame. */
export type FrameCommand = { readonly id: number; readonly command: 'close' } | { readonly id: number; readonly command: 'navigate'; readonly url: string };

/** Runs one permission check through the workspace page. */
async function requirePermission(caller: WindowCaller, action: string, url: string): Promise<void> {
  const answer = await callWorkspace<{ ok: boolean; error?: string }>('permission.check', {
    principal: caller.principal,
    action,
    target: { kind: 'window', url },
    description: `window ${url}`,
    source: caller.source ?? null,
    preauthorized: caller.preauthorized === true,
  });
  if (!answer?.ok) {
    throw new Error(answer?.error ?? `Permission denied: "${caller.principal}" may not run "${action}" on window ${url}.`);
  }
}

/**
 * Maps one tool address to the address the window loads. A relative path resolves against the
 * app root, like the NW.js window open did.
 *
 * @param url The address of the open call.
 * @returns The absolute app:// address.
 */
function toAppAddress(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    return url;
  }
  const path = url.replace(/^\/+/, '');
  if (path.startsWith('plugins/')) {
    return `app://plugins/${path.slice('plugins/'.length)}`;
  }
  const underRenderer = path.startsWith('dist/renderer/') ? path.slice('dist/renderer/'.length) : path;
  return `app://renderer/${underRenderer}`;
}

/** The slice of one CDP evaluation reply the coercion reads. */
interface CdpEvaluateReply {
  result?: { type?: string; subtype?: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
}

/** Coerces one CDP evaluation reply into the normalized result. */
function coerceEvaluateResult(raw: unknown): EvaluateResult {
  const reply = raw as CdpEvaluateReply | null;
  const details = reply?.exceptionDetails;
  if (details) {
    const message = details.exception?.description ?? (typeof details.exception?.value === 'string' ? details.exception.value : details.text);
    throw new Error(message && message.length > 0 ? message : 'The evaluation failed.');
  }
  const result = reply?.result;
  const type = result?.type === 'object' && result.subtype === 'null' ? 'null' : (result?.type ?? 'undefined');
  if (type === 'undefined') {
    return { type };
  }
  if (type === 'object') {
    // eslint-disable-next-line local/prefer-truthiness -- a false or zero result value is real data, not an absent field
    if (result?.value !== undefined) {
      return { type, value: result.value };
    }
    try {
      return { type, value: JSON.parse(result?.description ?? 'null') };
    } catch {
      return { type, description: result?.description ?? null };
    }
  }
  const description = result?.description;
  return { type, value: result?.value, ...(description ? { description } : {}) };
}

/** Reads the CDP error of one debugger reply. */
function debuggerError(result: unknown): string | null {
  const candidate = result as { code?: number; message?: string } | null;
  return candidate && typeof candidate.message === 'string' ? candidate.message : null;
}

/** Sends one debugger command on the contents of one record. */
async function sendDebugger(record: ChildRecord, method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!record.contents) {
    throw new Error(`Child window ${record.id} has no debug session. Attach it first.`);
  }
  const debuggerApi = record.contents.debugger;
  if (!debuggerApi.isAttached()) {
    throw new Error(`Child window ${record.id} has no debug session. Attach it first.`);
  }
  return debuggerApi.sendCommand(method, params ?? {});
}

/** Owns the child windows and their sessions. */
class SessionService {
  private readonly children = new Map<number, ChildRecord>();
  private nextChildId = 1;
  private defaultFrame: boolean | undefined;

  /** Sets the frame flag child windows inherit when the caller gives none. */
  setDefaultFrame(frame: boolean | undefined): void {
    this.defaultFrame = frame;
  }

  /** Lists the tracked children with their live URL and title. */
  listChildren(): ChildWindowInfo[] {
    const infos: ChildWindowInfo[] = [];
    for (const record of this.children.values()) {
      infos.push({
        id: record.id,
        url: record.contents?.getURL() || record.url,
        title: (record.contents?.getTitle() || record.title || record.url),
        attached: record.session !== null,
        kind: record.kind,
        ...(record.kind === 'webview' ? { shared: record.shared } : {}),
      });
    }
    return infos;
  }

  /**
   * Reserves one frame record and asks the workspace page to build its panel.
   *
   * @param caller The caller that opens the frame.
   * @param url The app address the frame loads.
   * @param kind The embed kind of the frame.
   * @param side The column of the frame.
   * @param title The title the title bar shows, or null for the default.
   * @returns The frame id and the build facts.
   */
  async openFrame(
    caller: WindowCaller,
    url: string,
    kind: 'iframe' | 'webview',
    side: 'left' | 'right',
    title: string | null,
  ): Promise<{ id: number; kind: 'iframe' | 'webview'; side: 'left' | 'right' }> {
    const address = toAppAddress(url);
    await requirePermission(caller, 'open', address);
    const id = this.nextChildId;
    this.nextChildId += 1;
    const frameTitle = title !== null && title.length > 0 ? title : address.split('/').filter((part) => part.length > 0).at(-1) ?? address;
    this.children.set(id, { id, contents: null, kind, url: address, title: frameTitle, shared: false, session: null });
    await callWorkspace('frames.build', { id, kind, url: address, title: frameTitle, side });
    return { id, kind, side };
  }

  /**
   * Binds the guest contents of one webview frame to its record. The guest preload announces
   * itself with the frame token of its address.
   *
   * @param id The frame id.
   * @param contents The guest contents.
   */
  bindGuestContents(id: number, contents: WebContents): void {
    const record = this.children.get(id);
    if (record === undefined || record.kind !== 'webview') {
      return;
    }
    record.contents = contents;
    contents.once('destroyed', () => {
      const current = this.children.get(id);
      if (current !== undefined && current.contents === contents) {
        this.children.delete(id);
        pushWorkspace('frames.command', { id, command: 'close' });
      }
    });
  }

  /** Notes the share switch state of one webview frame, which gates every debug attach. */
  setFrameShared(id: number, shared: boolean): void {
    const record = this.children.get(id);
    if (record) {
      record.shared = shared;
    }
  }

  /**
   * Opens one child window.
   *
   * @param caller The caller that opens the window.
   * @param url The address the child loads.
   * @param options The size and frame of the window.
   * @returns The child id.
   */
  async openChild(
    caller: WindowCaller,
    url: string,
    options?: { width?: number; height?: number; frame?: boolean },
  ): Promise<number> {
    const address = toAppAddress(url);
    await requirePermission(caller, 'open', address);
    const frame = options?.frame ?? this.defaultFrame;
    const win = new BrowserWindow({
      width: options?.width ?? DEFAULT_CHILD_SIZE.width,
      height: options?.height ?? DEFAULT_CHILD_SIZE.height,
      // eslint-disable-next-line local/prefer-truthiness -- frame false means borderless, a real setting
      ...(frame !== undefined ? { frame } : {}),
      title: 'NodeWavenUI',
      icon: join(APP_ROOT, 'icons', 'icon-256.png'),
      webPreferences: {
        preload: join(APP_ROOT, 'src', 'preload', 'app-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const id = this.track(win.webContents, 'window', address);
    win.on('closed', () => {
      this.children.delete(id);
    });
    await win.loadURL(address);
    return id;
  }

  /** Registers the workspace window itself as a tracked child. */
  exposeMainWindow(contents: WebContents): number {
    setWorkspaceContents(contents);
    return this.track(contents, 'window', contents.getURL());
  }

  /** Puts one web contents into the id space. */
  private track(contents: WebContents, kind: ChildRecord['kind'], url: string): number {
    const id = this.nextChildId;
    this.nextChildId += 1;
    this.children.set(id, { id, contents, kind, url, title: url, shared: false, session: null });
    return id;
  }

  /**
   * Closes one child.
   *
   * @param caller The caller that closes the child.
   * @param id The child id. An unknown child does nothing.
   */
  async closeChild(caller: WindowCaller, id: number): Promise<void> {
    const record = this.children.get(id);
    if (!record) {
      return;
    }
    await requirePermission(caller, 'close', record.contents?.getURL() || record.url);
    this.children.delete(id);
    const session = record.session;
    if (session) {
      record.session = null;
      try {
        record.contents?.debugger.detach();
      } catch {
        // A guest that already left needs no detach.
      }
    }
    if (record.kind !== 'window') {
      // The panel of a frame lives in the workspace page; the guest of a webview frame ends here.
      try {
        record.contents?.close();
      } catch {
        // A guest that already left needs no closing.
      }
      pushWorkspace('frames.command', { id, command: 'close' });
      return;
    }
    if (record.contents) {
      BrowserWindow.fromWebContents(record.contents)?.close();
    }
  }

  /** Closes every tracked child. The workspace drain uses it. */
  async closeAllChildren(caller: WindowCaller): Promise<void> {
    for (const id of [...this.children.keys()]) {
      try {
        await this.closeChild(caller, id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] child window ${id} did not close cleanly: ${message}`);
      }
    }
  }

  /** Reads the record of one child. */
  private requireRecord(id: number): ChildRecord {
    const record = this.children.get(id);
    if (!record) {
      throw new Error(`Child window ${id} is unknown.`);
    }
    return record;
  }

  /**
   * Attaches a debug session to one child and starts the console capture.
   *
   * @param caller The caller that attaches. The session records its principal as the owner.
   * @param id The child id.
   */
  async attach(caller: WindowCaller, id: number): Promise<void> {
    const record = this.requireRecord(id);
    if (record.session) {
      throw new Error(`Child window ${id} already has a debug session.`);
    }
    if (record.kind === 'iframe') {
      throw new Error('An iframe frame shares the debug target of the workspace window. Attach runs on webview frames only.');
    }
    if (record.kind === 'webview' && !record.shared) {
      throw new Error(
        `Permission denied: the webview frame "${record.title}" is not shared. Turn on sharing in its title bar.`,
      );
    }
    if (!record.contents) {
      throw new Error(`The webview frame "${record.title}" has no guest yet. Wait a moment and attach again.`);
    }
    await requirePermission(caller, 'attach', record.contents.getURL());
    const session: DebugSession = { contentsId: record.contents.id, owner: caller.principal, consoleEntries: [] };
    record.contents.debugger.on('message', (_event, method: string, params: unknown) => {
      this.captureConsole(session, method, params);
    });
    try {
      record.contents.debugger.attach('1.3');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`The debug session could not attach: ${message}`, { cause: error });
    }
    record.session = session;
    await sendDebugger(record, 'Runtime.enable');
    await sendDebugger(record, 'Page.enable');
  }

  /** Captures the console events of one session. */
  private captureConsole(session: DebugSession, method: string, params: unknown): void {
    const at = new Date().toISOString();
    if (method === 'Runtime.consoleAPICalled') {
      const call = params as { type?: string; args?: { value?: unknown; description?: string }[] } | null;
      const text = (call?.args ?? []).map((argument) => (typeof argument.value === 'string' ? argument.value : (argument.description ?? String(argument.value ?? 'null')))).join(' ');
      session.consoleEntries.push({ kind: call?.type === 'error' ? 'error' : 'log', text, at });
    } else if (method === 'Runtime.exceptionThrown') {
      const thrown = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } } | null;
      const text = thrown?.exceptionDetails?.exception?.description ?? thrown?.exceptionDetails?.text ?? 'exception';
      session.consoleEntries.push({ kind: 'error', text, at });
    }
    if (session.consoleEntries.length > CONSOLE_BUFFER_LIMIT) {
      session.consoleEntries.shift();
    }
  }

  /** Reads the session of one child. */
  private requireSession(id: number): { record: ChildRecord; session: DebugSession } {
    const record = this.requireRecord(id);
    if (!record.session) {
      throw new Error(`Child window ${id} has no debug session. Attach it first.`);
    }
    return { record, session: record.session };
  }

  /**
   * Detaches the debug session of one child.
   *
   * @param caller The caller that detaches.
   * @param id The child id.
   */
  async detach(caller: WindowCaller, id: number): Promise<void> {
    const { record, session } = this.requireSession(id);
    if (session.owner !== caller.principal) {
      throw new Error(`Permission denied: "${caller.principal}" does not own the session of child window ${id}.`);
    }
    const contents = this.requireContents(record);
    await requirePermission(caller, 'detach', contents.getURL());
    record.session = null;
    try {
      contents.debugger.detach();
    } catch {
      // A detached guest needs no second detach.
    }
  }

  /**
   * Runs one JavaScript expression in one child.
   *
   * @param caller The caller that evaluates.
   * @param id The child id.
   * @param expression The JavaScript source to run.
   * @returns The normalized result. A promise result is awaited; objects come back as parsed JSON values.
   */
  async evaluate(caller: WindowCaller, id: number, expression: string): Promise<EvaluateResult> {
    const { record } = this.requireSession(id);
    await requirePermission(caller, 'evaluate', this.requireContents(record).getURL());
    const raw = await sendDebugger(record, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return coerceEvaluateResult(raw);
  }

  /**
   * Captures one screenshot of one child.
   *
   * @param caller The caller that captures.
   * @param id The child id.
   * @param format The image format.
   * @returns The image as base64 data.
   */
  async captureScreenshot(caller: WindowCaller, id: number, format: 'png' | 'jpeg'): Promise<string> {
    const { record } = this.requireSession(id);
    await requirePermission(caller, 'screenshot', this.requireContents(record).getURL());
    const raw = await sendDebugger(record, 'Page.captureScreenshot', { format });
    const data = (raw as { data?: unknown } | null)?.data;
    if (typeof data !== 'string') {
      throw new Error('The screenshot returned no image.');
    }
    return data;
  }

  /** Reads the captured console lines of one child. */
  async consoleEntries(caller: WindowCaller, id: number): Promise<readonly ConsoleEntry[]> {
    const { record, session } = this.requireSession(id);
    await requirePermission(caller, 'console.read', this.requireContents(record).getURL());
    return [...session.consoleEntries];
  }

  /** Clears the captured console of one child. */
  async clearConsole(caller: WindowCaller, id: number): Promise<void> {
    const { record, session } = this.requireSession(id);
    await requirePermission(caller, 'console.clear', this.requireContents(record).getURL());
    session.consoleEntries.length = 0;
  }

  /**
   * Loads one address in one child.
   *
   * @param caller The caller that navigates.
   * @param id The child id.
   * @param url The address to load.
   */
  async navigate(caller: WindowCaller, id: number, url: string): Promise<void> {
    const record = this.requireRecord(id);
    await requirePermission(caller, 'navigate', record.contents?.getURL() || record.url);
    if (record.session) {
      const raw = await sendDebugger(record, 'Page.navigate', { url });
      const errorText = debuggerError(raw) ?? (raw as { errorText?: string } | null)?.errorText;
      if (typeof errorText === 'string' && errorText.length > 0) {
        throw new Error(`The navigation to "${url}" failed: ${errorText}`);
      }
      return;
    }
    if (record.kind !== 'window') {
      // The panel of a frame lives in the workspace page: the navigation runs there.
      record.url = toAppAddress(url);
      pushWorkspace('frames.command', { id, command: 'navigate', url: record.url });
      return;
    }
    if (record.contents) {
      await record.contents.loadURL(toAppAddress(url));
    }
  }

  /** Opens the DevTools window of one child. */
  async openDevTools(caller: WindowCaller, id: number): Promise<void> {
    const record = this.requireRecord(id);
    if (record.kind === 'iframe') {
      throw new Error('An iframe frame shares the DevTools of the workspace window. Open DevTools on the workspace window instead.');
    }
    const contents = record.contents;
    if (!contents) {
      throw new Error(`Child window ${id} has no contents to open DevTools on.`);
    }
    await requirePermission(caller, 'devtools', contents.getURL());
    contents.openDevTools({ mode: 'detach' });
  }

  /** Reads the contents of one record, which every session operation needs. */
  private requireContents(record: ChildRecord): WebContents {
    if (!record.contents) {
      throw new Error(`Child window ${record.id} has no debug session. Attach it first.`);
    }
    return record.contents;
  }
}

/** The one session service of the app. */
export const sessions = new SessionService();

/** Reads the app root, for the preload paths of child windows. */
export function appRootPath(): string {
  return APP_ROOT;
}
