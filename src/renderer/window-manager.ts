/**
 * Child window manager: opens child windows, tracks them, and owns their debug sessions.
 * The sessions run through the chrome.debugger extension API, which the NW.js SDK build exposes without a manifest permission.
 * The manager attaches only to child windows that it opened itself. The main window and the background page never attach, and no debug port opens.
 * Every public method carries the principal that acts, and the permission gate guards each action (see the permission model in `src/shared/permissions.ts`).
 */

import { outranks, type PrincipalKind } from '../shared/permissions.js';
import { openChildWindow, readMainWindowAsChild, type NwChildWindow } from '../shared/nw.js';
import type { PermissionGate } from './permission-gate.js';

/** One captured console line or exception of a debug session. */
export interface ConsoleEntry {
  readonly kind: 'console' | 'exception';
  readonly level: 'log' | 'info' | 'warning' | 'error' | 'debug' | 'exception';
  readonly text: string;
  readonly timestamp: number;
}

/** The public view of one tracked child window. */
export interface ChildWindowInfo {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly attached: boolean;
}

/** The normalized result of one evaluation in a child window. A returned object or array arrives as a parsed JSON value in `value`. */
export interface EvaluateResult {
  readonly type: string;
  readonly value: string | number | boolean | object | null;
  readonly description: string | null;
}

/** One debug target as the chrome.debugger API reports it. */
interface DebuggerTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string | null;
  readonly attached: boolean;
}

/** Identifies one debug target in the chrome.debugger API. */
interface Debuggee {
  readonly targetId: string;
}

/** The slice of the chrome.debugger API the manager uses. */
interface DebuggerApi {
  readonly getTargets: (callback: (targets: unknown) => void) => void;
  readonly attach: (debuggee: Debuggee, requiredVersion: string, callback: () => void) => void;
  readonly detach: (debuggee: Debuggee, callback: () => void) => void;
  readonly sendCommand: (
    debuggee: Debuggee,
    method: string,
    commandParams: Record<string, unknown>,
    callback: (result: unknown) => void,
  ) => void;
  readonly onEvent: {
    addListener: (listener: (source: { targetId?: string }, method: string, params: unknown) => void) => void;
  };
  readonly onDetach: {
    addListener: (listener: (source: { targetId?: string }, reason?: string) => void) => void;
  };
}

/** The chrome global as the manager reads it. */
interface ChromeGlobal {
  readonly runtime?: { readonly lastError?: { readonly message?: string } };
}

/** The chrome.debugger binding with the chrome global it needs for error reads. */
type DebuggerBinding = { readonly chrome: ChromeGlobal; readonly api: DebuggerApi };

/** One live debug session of one child window. */
interface DebugSession {
  readonly targetId: string;
  /** The principal that attached the session. Detaching it from outside needs a higher level. */
  readonly owner: PrincipalKind;
  readonly consoleEntries: ConsoleEntry[];
}

/** The internal record of one tracked child window. */
interface ChildRecord {
  readonly id: number;
  readonly window: NwChildWindow;
  url: string;
  title: string;
  session: DebugSession | null;
  attaching: boolean;
  /** True while a DevTools window is open on this child. No session attaches while it is open. */
  devtoolsOpen: boolean;
}

/** One CDP remote object, the carrier of console arguments and results. */
interface RemoteObject {
  readonly type?: string;
  readonly value?: unknown;
  readonly description?: string;
}

/** The protocol version the chrome.debugger API requires on attach. */
const DEBUGGER_PROTOCOL_VERSION = '1.3';

/** The console buffer keeps the newest entries per session. */
const CONSOLE_BUFFER_LIMIT = 500;

/** The window size a child window takes when the caller gives none. */
const DEFAULT_CHILD_SIZE = { width: 900, height: 700 } as const;

/** Who calls a window action, and where the call came from. */
export interface WindowCaller {
  readonly principal: PrincipalKind;
  /** The origin of the call, for example the MCP session id, so permission requests route to the right tab. */
  readonly source?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asRemoteObject(value: unknown): RemoteObject {
  const record = asRecord(value);
  return record === null ? {} : (record as RemoteObject);
}

/**
 * Reads the chrome.debugger binding.
 *
 * @returns The binding, or null when the API is absent. The SDK build provides it.
 */
function readDebuggerBinding(): DebuggerBinding | null {
  const chrome = asRecord((globalThis as { chrome?: unknown }).chrome);
  const api = chrome === null ? null : asRecord(chrome['debugger']);
  if (api === null) {
    return null;
  }
  const onEvent = asRecord(api['onEvent']);
  const onDetach = asRecord(api['onDetach']);
  if (
    typeof api['getTargets'] !== 'function' ||
    typeof api['attach'] !== 'function' ||
    typeof api['detach'] !== 'function' ||
    typeof api['sendCommand'] !== 'function' ||
    onEvent === null ||
    typeof onEvent['addListener'] !== 'function' ||
    onDetach === null ||
    typeof onDetach['addListener'] !== 'function'
  ) {
    return null;
  }
  return { chrome: chrome as unknown as ChromeGlobal, api: api as unknown as DebuggerApi };
}

/** Reads the last error of one debugger callback. The message is null when the call succeeded. */
function readLastError(chrome: ChromeGlobal): string | null {
  const lastError = chrome.runtime?.lastError;
  return typeof lastError?.message === 'string' ? lastError.message : null;
}

/**
 * Runs one chrome.debugger callback style call as a promise.
 *
 * @param binding The debugger binding.
 * @param invoke The call. The done callback it receives carries the result.
 * @throws Error with the chrome.runtime.lastError message when the call failed.
 */
function debuggerCall<T>(binding: DebuggerBinding, invoke: (done: (result: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((result: unknown) => {
      const message = readLastError(binding.chrome);
      if (message !== null) {
        reject(new Error(message));
        return;
      }
      resolve(result as T);
    });
  });
}

/** Normalizes one debug target list from the API. */
function coerceTargets(raw: unknown): DebuggerTarget[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const targets: DebuggerTarget[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null || typeof record['id'] !== 'string' || typeof record['type'] !== 'string') {
      continue;
    }
    targets.push({
      id: record['id'],
      type: record['type'],
      url: typeof record['url'] === 'string' ? record['url'] : null,
      attached: record['attached'] === true,
    });
  }
  return targets;
}

/** Renders one remote object as text for the console buffer. */
function describeRemoteObject(object: RemoteObject): string {
  if (object.value !== undefined) {
    return typeof object.value === 'string' ? object.value : (JSON.stringify(object.value) ?? String(object.value));
  }
  return typeof object.description === 'string' ? object.description : `[${object.type ?? 'unknown'}]`;
}

function readTimestamp(value: unknown): number {
  return typeof value === 'number' ? value : Date.now();
}

function coerceConsoleEntry(params: unknown): ConsoleEntry {
  const record = asRecord(params);
  const rawArgs = record === null ? null : record['args'];
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const text = args.map((arg) => describeRemoteObject(asRemoteObject(arg))).join(' ');
  const rawType = record !== null && typeof record['type'] === 'string' ? record['type'] : 'log';
  const level: ConsoleEntry['level'] =
    rawType === 'warning' || rawType === 'error' || rawType === 'info' || rawType === 'debug' ? rawType : 'log';
  return {
    kind: 'console',
    level,
    text,
    timestamp: readTimestamp(record === null ? undefined : record['timestamp']),
  };
}

function coerceExceptionEntry(params: unknown): ConsoleEntry {
  const record = asRecord(params);
  const details = asRecord(record === null ? null : record['exceptionDetails']);
  const nested = asRecord(details === null ? null : details['exception']);
  const description =
    nested !== null && typeof nested['description'] === 'string'
      ? nested['description']
      : details !== null && typeof details['text'] === 'string'
        ? details['text']
        : 'unknown exception';
  return {
    kind: 'exception',
    level: 'exception',
    text: description,
    timestamp: readTimestamp(record === null ? undefined : record['timestamp']),
  };
}

/** Normalizes one Runtime.evaluate reply. A thrown exception rejects the promise. A returned object or array arrives as a parsed JSON value. */
function coerceEvaluateResult(raw: unknown): EvaluateResult {
  const record = asRecord(raw) ?? {};
  const exception = asRecord(record['exceptionDetails']);
  if (exception !== null) {
    const nested = asRecord(exception['exception']);
    const description =
      nested !== null && typeof nested['description'] === 'string'
        ? nested['description']
        : typeof exception['text'] === 'string'
          ? exception['text']
          : '';
    throw new Error(description.length > 0 ? description : 'The evaluation threw an exception.');
  }
  const object = asRemoteObject(record['result']);
  const value = object.value;
  let normalized: EvaluateResult['value'];
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'object'
  ) {
    // Runtime.evaluate runs with returnByValue, so an object or array arrives as a plain JSON value.
    // It travels on as a value, not as a JSON text, so nested objects stay objects.
    normalized = value;
  } else if (typeof value === 'bigint') {
    // A bigint has no JSON form, so it travels as its literal text.
    normalized = `${value.toString()}n`;
  } else {
    normalized = null;
  }
  return {
    type: typeof object.type === 'string' ? object.type : 'unknown',
    value: normalized,
    description: typeof object.description === 'string' ? object.description : null,
  };
}

/** Tracks the child windows and drives their debug sessions. */
export class ChildWindowManager {
  private readonly children = new Map<number, ChildRecord>();
  private nextChildId = 1;
  private readonly changeListeners = new Set<() => void>();
  private readonly debug: DebuggerBinding | null = readDebuggerBinding();
  private readonly gate: PermissionGate | null;
  private pageGlobalsProvider: (() => Record<string, unknown>) | null = null;
  /** The frame a child window takes when its caller gives none. Undefined keeps the NW.js default. */
  private defaultFrame: boolean | undefined;

  /**
   * @param gate The permission gate that guards every action. Without a gate, only `user` and `plugin` pass.
   */
  constructor(gate: PermissionGate | null = null) {
    this.gate = gate;
    if (this.debug !== null) {
      this.debug.api.onEvent.addListener((source, method, params) => {
        this.handleDebuggerEvent(source, method, params);
      });
      this.debug.api.onDetach.addListener((source, reason) => {
        this.handleDebuggerDetach(source, reason);
      });
    }
  }

  /** True when the chrome.debugger API is present. The SDK build provides it. */
  get debugApiAvailable(): boolean {
    return this.debug !== null;
  }

  /**
   * Sets the provider of the page globals every child window receives, for example the `nodewavenMcp` API.
   * The functions close over the main context, so calls from child-window code run main-side.
   *
   * @param provider Builds the globals object. Null clears the globals.
   */
  setPageGlobalsProvider(provider: (() => Record<string, unknown>) | null): void {
    this.pageGlobalsProvider = provider;
    for (const record of this.children.values()) {
      this.injectPageGlobals(record);
    }
  }

  /** Injects the page globals into one child window. A page that refuses them stays without them. */
  private injectPageGlobals(record: ChildRecord): void {
    const provider = this.pageGlobalsProvider;
    if (provider === null) {
      return;
    }
    const dom = record.window.window;
    if (typeof dom !== 'object' || dom === null) {
      return;
    }
    (dom as { nodewavenMcp?: unknown }).nodewavenMcp = provider();
  }

  /** Injects the page globals into every known child again, because a navigation dropped them. */
  private reinjectPageGlobals(): void {
    for (const record of this.children.values()) {
      this.injectPageGlobals(record);
    }
  }

  /**
   * Injects the page globals into one child window before evaluated code runs.
   *
   * @param id The child id.
   * @returns True when the child is known. The injection outcome stays unreported: a page that
   * refuses the globals still runs its evaluation.
   */
  ensurePageGlobals(id: number): boolean {
    const record = this.children.get(id);
    if (record === undefined) {
      return false;
    }
    this.injectPageGlobals(record);
    return true;
  }

  /**
   * Checks one window action through the permission gate.
   *
   * @param caller The caller with its principal and origin.
   * @param action The window action.
   * @param url The URL of the child window.
   * @throws Error when the permission pipeline denies the action, or when no gate is wired and the principal is below `plugin`.
   */
  private async requirePermission(caller: WindowCaller, action: string, url: string): Promise<void> {
    if (this.gate === null) {
      if (caller.principal === 'user' || caller.principal === 'plugin') {
        return;
      }
      throw new Error(`Permission denied: no permission gate is wired, so "${caller.principal}" may not run "${action}" on window ${url}.`);
    }
    await this.gate.check(caller.principal, action, { kind: 'window', url }, `window ${url}`, caller.source ?? null);
  }

  /**
   * Sets the frame a child window takes when its caller gives none.
   * The workspace window sets it to its own frame mode, so child windows inherit it.
   *
   * @param frame The inherited frame flag, or undefined to keep the NW.js default.
   */
  setDefaultFrame(frame: boolean | undefined): void {
    this.defaultFrame = frame;
  }

  /**
   * Opens one child window and starts tracking it.
   *
   * @param caller The caller that opens the window.
   * @param url The address the child loads.
   * @param options The window size and frame. The size defaults to 900 by 700, the frame to the inherited default.
   * @returns The child id.
   * @throws Error when the permission pipeline denies the call or NW.js cannot open the window.
   */
  async openChild(
    caller: WindowCaller,
    url: string,
    options?: { readonly width?: number; readonly height?: number; readonly frame?: boolean | undefined },
  ): Promise<number> {
    await this.requirePermission(caller, 'open', url);
    const frame = options?.frame ?? this.defaultFrame;
    const childWindow = await openChildWindow(url, {
      width: options?.width ?? DEFAULT_CHILD_SIZE.width,
      height: options?.height ?? DEFAULT_CHILD_SIZE.height,
      ...(frame !== undefined ? { frame } : {}),
    });
    if (childWindow === null) {
      throw new Error('The child window could not open. The NW.js window API is not available.');
    }
    const id = this.nextChildId;
    this.nextChildId += 1;
    const record: ChildRecord = { id, window: childWindow, url, title: '', session: null, attaching: false, devtoolsOpen: false };
    this.children.set(id, record);
    childWindow.on('closed', () => {
      this.children.delete(id);
      this.notifyChange();
    });
    childWindow.on('devtools-closed', () => {
      record.devtoolsOpen = false;
      this.notifyChange();
    });
    this.injectPageGlobals(record);
    // The page loads after the open, so a second pass catches the settled document.
    window.setTimeout(() => {
      this.injectPageGlobals(record);
    }, 1500);
    this.notifyChange();
    return id;
  }

  /**
   * Registers the main app window as a tracked window, so chats and the MCP host reach it like a child window.
   * Dangerous: an agent that breaks the page bricks the app. The caller owns the warning.
   *
   * @returns The window id, or null when the window wrapper is unreachable.
   */
  exposeMainWindow(): number | null {
    const handle = readMainWindowAsChild();
    if (handle === null) {
      return null;
    }
    const id = this.nextChildId;
    this.nextChildId += 1;
    const record: ChildRecord = {
      id,
      window: handle,
      url: globalThis.location.href,
      title: globalThis.document.title,
      session: null,
      attaching: false,
      devtoolsOpen: false,
    };
    this.children.set(id, record);
    this.notifyChange();
    return id;
  }

  /**
   * Lists the tracked child windows with their current URL and title.
   *
   * @returns The public view of every child, in open order.
   */
  listChildren(): ChildWindowInfo[] {
    const infos: ChildWindowInfo[] = [];
    for (const record of this.children.values()) {
      this.refreshRecord(record);
      infos.push({ id: record.id, url: record.url, title: record.title, attached: record.session !== null });
    }
    return infos;
  }

  /**
   * Closes one child window and stops tracking it.
   *
   * @param caller The caller that closes the window.
   * @param id The child id. An unknown child does nothing.
   * @throws Error when the permission pipeline denies the call.
   */
  async closeChild(caller: WindowCaller, id: number): Promise<void> {
    const record = this.children.get(id);
    if (record === undefined) {
      return;
    }
    await this.requirePermission(caller, 'close', record.url);
    const session = record.session;
    this.children.delete(id);
    if (session !== null) {
      void this.detachSession(session).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the debug session of child ${id} did not detach cleanly: ${message}`);
      });
    }
    record.window.close();
    this.notifyChange();
  }

  /**
   * Closes every tracked child window, one after another. The shutdown path of the main window uses it:
   * NW.js keeps the process alive while any window stays open, so a surviving child would wedge the app.
   * A child that refuses to close does not stop the drain.
   *
   * @param caller The caller that closes the windows.
   */
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

  /**
   * Attaches a debug session to one child window and starts the console capture.
   *
   * @param caller The caller that attaches. The session records its principal as the owner.
   * @param id The child id.
   * @throws Error when the permission pipeline denies the call, DevTools are open on the child, the debug API is missing, the child is unknown, or no free target matches the child.
   */
  async attach(caller: WindowCaller, id: number): Promise<void> {
    const record = this.children.get(id);
    if (record === undefined) {
      throw new Error(`Child window ${id} is unknown.`);
    }
    if (record.devtoolsOpen) {
      throw new Error('DevTools are open on this child window. Close them before you attach a session.');
    }
    if (record.session !== null || record.attaching) {
      return;
    }
    await this.requirePermission(caller, 'attach', record.url);
    const principal = caller.principal;
    const debug = this.debug;
    if (debug === null) {
      throw new Error('The debug API is not available. Start the SDK build of NW.js.');
    }
    record.attaching = true;
    try {
      this.refreshRecord(record);
      const targetId = await this.resolveTargetId(debug, record);
      await debuggerCall(debug, (done) =>
        debug.api.attach({ targetId }, DEBUGGER_PROTOCOL_VERSION, () => done(undefined)),
      );
      const session: DebugSession = { targetId, owner: principal, consoleEntries: [] };
      record.session = session;
      await debuggerCall(debug, (done) => debug.api.sendCommand({ targetId }, 'Runtime.enable', {}, done));
      await debuggerCall(debug, (done) => debug.api.sendCommand({ targetId }, 'Page.enable', {}, done));
    } finally {
      record.attaching = false;
    }
    this.notifyChange();
  }

  /**
   * Detaches the debug session of one child window.
   * Detaching the session of another principal needs a strictly higher level, so for example `mcp` detaches an `agent` session but no `user` DevTools.
   * A session that did not detach cleanly still clears, because the target is gone in that case.
   *
   * @param principal The principal that detaches.
   * @param id The child id. An unknown child or a missing session does nothing.
   * @throws Error when the principal does not own the session and does not outrank the owner.
   */
  async detach(caller: WindowCaller, id: number): Promise<void> {
    const record = this.children.get(id);
    if (record === undefined) {
      return;
    }
    const session = record.session;
    if (session === null) {
      return;
    }
    if (session.owner !== caller.principal && !outranks(caller.principal, session.owner)) {
      throw new Error(
        `Permission denied: "${caller.principal}" does not outrank the session owner "${session.owner}" of child window ${id}.`,
      );
    }
    await this.requirePermission(caller, 'detach', record.url);
    try {
      await this.detachSession(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the debug session of child ${id} did not detach cleanly: ${message}`);
    }
    record.session = null;
    this.notifyChange();
  }

  /**
   * Evaluates one expression in a child window.
   *
   * @param caller The caller that evaluates.
   * @param id The child id. A debug session must be attached.
   * @param expression The JavaScript source to run.
   * @throws Error when the permission pipeline denies the call, no session is attached, or the expression throws.
   */
  async evaluate(caller: WindowCaller, id: number, expression: string): Promise<EvaluateResult> {
    const session = this.requireSession(id);
    await this.requirePermission(caller, 'evaluate', this.children.get(id)?.url ?? '');
    const debug = this.requireDebug();
    const raw = await debuggerCall<unknown>(debug, (done) =>
      debug.api.sendCommand({ targetId: session.targetId }, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }, done),
    );
    return coerceEvaluateResult(raw);
  }

  /**
   * Captures one screenshot of a child window.
   *
   * @param caller The caller that captures.
   * @param id The child id. A debug session must be attached.
   * @param format The image format. Defaults to png.
   * @returns The image as base64 data.
   * @throws Error when the permission pipeline denies the call, no session is attached, or the capture returns no image.
   */
  async captureScreenshot(caller: WindowCaller, id: number, format: 'png' | 'jpeg' = 'png'): Promise<string> {
    const session = this.requireSession(id);
    await this.requirePermission(caller, 'screenshot', this.children.get(id)?.url ?? '');
    const debug = this.requireDebug();
    const raw = await debuggerCall<unknown>(debug, (done) =>
      debug.api.sendCommand({ targetId: session.targetId }, 'Page.captureScreenshot', { format }, done),
    );
    const record = asRecord(raw) ?? {};
    const data = record['data'];
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('The screenshot returned no image data.');
    }
    return data;
  }

  /**
   * Reads the captured console of one child window.
   *
   * @param caller The caller that reads.
   * @param id The child id.
   * @returns The buffered entries. A child without a session has an empty console.
   * @throws Error when the permission pipeline denies the call.
   */
  async consoleEntries(caller: WindowCaller, id: number): Promise<readonly ConsoleEntry[]> {
    await this.requirePermission(caller, 'console.read', this.children.get(id)?.url ?? '');
    const session = this.children.get(id)?.session;
    if (session === null || session === undefined) {
      return [];
    }
    return [...session.consoleEntries];
  }

  /**
   * Clears the captured console of one child window.
   *
   * @param caller The caller that clears.
   * @param id The child id. A child without a session does nothing.
   * @throws Error when the permission pipeline denies the call.
   */
  async clearConsole(caller: WindowCaller, id: number): Promise<void> {
    await this.requirePermission(caller, 'console.clear', this.children.get(id)?.url ?? '');
    const session = this.children.get(id)?.session;
    if (session !== null && session !== undefined) {
      session.consoleEntries.length = 0;
      this.notifyChange();
    }
  }

  /**
   * Loads one address in a child window.
   * An attached session navigates through the debug protocol, a detached child through a script injection.
   *
   * @param caller The caller that navigates.
   * @param id The child id.
   * @param url The address to load.
   * @throws Error when the permission pipeline denies the call, the child is unknown, or neither path is available.
   */
  async navigate(caller: WindowCaller, id: number, url: string): Promise<void> {
    const record = this.children.get(id);
    if (record === undefined) {
      throw new Error(`Child window ${id} is unknown.`);
    }
    await this.requirePermission(caller, 'navigate', record.url);
    const session = record.session;
    const debug = this.debug;
    if (session !== null && debug !== null) {
      const raw = await debuggerCall<unknown>(debug, (done) =>
        debug.api.sendCommand({ targetId: session.targetId }, 'Page.navigate', { url }, done),
      );
      // Page.navigate reports a refused navigation through errorText, not through an exception.
      // Chromium refuses a top-level navigation to a data: URL, for example.
      const result = asRecord(raw);
      const errorText = result === null ? undefined : result['errorText'];
      if (typeof errorText === 'string' && errorText.length > 0) {
        throw new Error(`The navigation to "${url}" failed: ${errorText}`);
      }
      window.setTimeout(() => {
        this.reinjectPageGlobals();
      }, 1500);
      return;
    }
    record.window.eval(null, `location.href = ${JSON.stringify(url)};`);
    record.url = url;
    window.setTimeout(() => {
      this.reinjectPageGlobals();
    }, 1500);
  }

  /**
   * Opens the DevTools window of one child.
   * The DevTools outrank every session: opening them detaches the session of the child when the principal owns it or outranks the owner.
   *
   * @param principal The principal that opens DevTools.
   * @param id The child id.
   * @throws Error when the permission pipeline denies the call, the caller does not outrank the session owner, the child is unknown, or the build ships no DevTools.
   */
  async openDevTools(caller: WindowCaller, id: number): Promise<void> {
    const record = this.children.get(id);
    if (record === undefined) {
      throw new Error(`Child window ${id} is unknown.`);
    }
    await this.requirePermission(caller, 'devtools', record.url);
    const session = record.session;
    if (session !== null && session.owner !== caller.principal && !outranks(caller.principal, session.owner)) {
      throw new Error(
        `Permission denied: "${caller.principal}" does not outrank the session owner "${session.owner}" of child window ${id}.`,
      );
    }
    if (session !== null) {
      record.session = null;
      try {
        await this.detachSession(session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the debug session of child ${id} did not detach cleanly: ${message}`);
      }
    }
    const showDevTools = record.window.showDevTools;
    if (showDevTools === undefined) {
      throw new Error('DevTools are not available. Start the SDK build of NW.js.');
    }
    showDevTools();
    record.devtoolsOpen = true;
    this.notifyChange();
  }

  /**
   * Subscribes to every change of the child list, the session states, and the captured consoles.
   *
   * @param listener The listener each change calls.
   * @returns A function that removes the subscription.
   */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private requireSession(id: number): DebugSession {
    const session = this.children.get(id)?.session;
    if (session === null || session === undefined) {
      throw new Error(`Child window ${id} has no debug session. Attach it first.`);
    }
    return session;
  }

  private requireDebug(): DebuggerBinding {
    if (this.debug === null) {
      throw new Error('The debug API is not available. Start the SDK build of NW.js.');
    }
    return this.debug;
  }

  private detachSession(session: DebugSession): Promise<void> {
    const debug = this.debug;
    if (debug === null) {
      return Promise.resolve();
    }
    return debuggerCall(debug, (done) => debug.api.detach({ targetId: session.targetId }, () => done(undefined)));
  }

  /**
   * Finds the free debug target of one child window.
   * Two children that show the same URL cannot be told apart. The first unattached match wins.
   */
  private async resolveTargetId(debug: DebuggerBinding, record: ChildRecord): Promise<string> {
    const raw = await debuggerCall<unknown>(debug, (done) => debug.api.getTargets(done));
    const targets = coerceTargets(raw).filter(
      (target) => target.type === 'page' && target.url === record.url && !target.attached,
    );
    const match = targets[0];
    if (match === undefined) {
      throw new Error(`No free debug target matches the URL ${record.url}.`);
    }
    return match.id;
  }

  /** Reads the current URL and title from the DOM of the child window. */
  private refreshRecord(record: ChildRecord): void {
    const dom = record.window.window;
    if (typeof dom !== 'object' || dom === null) {
      return;
    }
    const candidate = dom as unknown as {
      readonly location?: { readonly href?: unknown };
      readonly document?: { readonly title?: unknown };
    };
    if (typeof candidate.location?.href === 'string') {
      record.url = candidate.location.href;
    }
    if (typeof candidate.document?.title === 'string') {
      record.title = candidate.document.title;
    }
  }

  private recordForTarget(targetId: string): ChildRecord | null {
    for (const record of this.children.values()) {
      if (record.session?.targetId === targetId) {
        return record;
      }
    }
    return null;
  }

  private handleDebuggerEvent(source: { targetId?: string }, method: string, params: unknown): void {
    const targetId = source.targetId;
    if (typeof targetId !== 'string') {
      return;
    }
    const session = this.recordForTarget(targetId)?.session;
    if (session === null || session === undefined) {
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      this.pushConsoleEntry(session, coerceConsoleEntry(params));
    } else if (method === 'Runtime.exceptionThrown') {
      this.pushConsoleEntry(session, coerceExceptionEntry(params));
    }
  }

  private handleDebuggerDetach(source: { targetId?: string }, reason?: string): void {
    const targetId = source.targetId;
    if (typeof targetId !== 'string') {
      return;
    }
    const record = this.recordForTarget(targetId);
    if (record === null || record.session === null) {
      return;
    }
    record.session = null;
    if (typeof reason === 'string' && reason.length > 0) {
      console.info(`[NodeWavenUI] the debug session of child ${record.id} ended: ${reason}`);
    }
    this.notifyChange();
  }

  private pushConsoleEntry(session: DebugSession, entry: ConsoleEntry): void {
    session.consoleEntries.push(entry);
    if (session.consoleEntries.length > CONSOLE_BUFFER_LIMIT) {
      session.consoleEntries.shift();
    }
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }
}
