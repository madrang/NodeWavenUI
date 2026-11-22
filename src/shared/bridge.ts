/**
 * The contract of the `nodewavenui` bridge: the surface the main process serves, the preload
 * exposes, and the sandboxed renderers call. Every renderer that needs Node reach holds this
 * object, injected by `src/preload/app-preload.cjs`. Frame guests load a smaller preload with
 * the `mcp` proxy only.
 */

import type { CoreStatus } from './core-api.js';

/** The file slice the renderers use. Paths are absolute, data crosses as text or bytes. */
export interface BridgeFileSystem {
  /** Reads the entry names of one directory. Rejects when the directory does not read. */
  list(directory: string): Promise<string[]>;
  /** Reads one file as utf-8 text. Rejects when the file does not read. */
  readText(path: string): Promise<string>;
  /** Reads one file as bytes. Rejects when the file does not read. */
  readData(path: string): Promise<Uint8Array>;
  /** Writes one file as utf-8 text, replacing what it held. */
  writeText(path: string, text: string): Promise<void>;
  /** Writes one file from bytes, replacing what it held. */
  writeData(path: string, data: Uint8Array): Promise<void>;
  /** Creates one directory, with every missing parent. */
  makeDirectory(path: string): Promise<void>;
  /** Removes one file or directory tree, also when partly absent. */
  remove(path: string): Promise<void>;
  /** Renames or moves one file or directory. */
  rename(from: string, to: string): Promise<void>;
  /** Reads one path. Null when nothing sits there. */
  stat(path: string): Promise<BridgeFileStat | null>;
}

/** What sits at one path. */
export interface BridgeFileStat {
  readonly exists: boolean;
  readonly directory: boolean;
}

/** The app facts and the native dialogs of the launcher flow. */
export interface BridgeApp {
  /** The version of the app. */
  version(): Promise<string>;
  /** The arguments the app started with, without the executable and its flags. */
  arguments(): Promise<string[]>;
  /** The absolute path of the app root directory. */
  appRoot(): Promise<string>;
  /** The platform of the host, `linux`, `darwin`, or `win32`. */
  platform(): Promise<string>;
  /** Opens the native directory picker. Null when the user cancels. */
  pickDirectory(title: string): Promise<string | null>;
}

/** The window placement of one app window. */
export interface BridgeWindowPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The window slice the app windows use. Every call names its window by the kind it serves. */
export interface BridgeWindows {  /** Sizes the window to one content size and locks resizing at it. */
  resizeLocked(width: number, height: number): Promise<void>;
  /** Sizes the window to one content size and leaves it resizable with a 200 by 200 minimum. */
  resizeResizable(width: number, height: number): Promise<void>;
  /** Reads the outer placement of the window. */
  placement(): Promise<BridgeWindowPlacement>;
  /** Applies one outer placement: position and size in the same call, so a restore is atomic. */
  setBounds(x: number, y: number, width: number, height: number): Promise<void>;
  /** Moves the window. */
  move(x: number, y: number): Promise<void>;
  /** Minimizes the window. */
  minimize(): Promise<void>;
  /** Maximizes the window, or restores it when it sits maximized. */
  toggleMaximize(): Promise<void>;
  /** Opens the developer tools of the window. A repeated call changes nothing. */
  openDevTools(): Promise<void>;
  /** Opens the developer tools of the window, or closes them when they sit open. */
  toggleDevTools(): Promise<void>;
  /** Closes the window through its close event, so a drain can still run. */
  close(): Promise<void>;
  /** Closes the window at once, past every close event. */
  forceClose(): Promise<void>;
  /** Subscribes to one window event: `close`, `moved`, `resized`, `maximize`, or `unmaximize`.
   * The reply stops the subscription. */
  on(event: 'close' | 'moved' | 'resized' | 'maximize' | 'unmaximize', listener: () => void): () => void;
  /**
   * Takes the handoff payload of this workspace window. The main process holds it from the open
   * until this call, so the page asks once its boot is ready to receive it.
   */
  takeHandoff(): Promise<unknown>;
  /**
   * Opens the workspace window for one launcher handoff. The payload stays in the main process
   * memory until the new window asks for it.
   */
  openWorkspace(handoff: unknown): Promise<void>;
}

/** One permission check the worker core runs. */
export interface BridgePermissionCheck {
  readonly principal: string;
  readonly action: string;
  readonly target: unknown;
  readonly description: string;
  readonly source: string | null;
  readonly preauthorized: boolean;
}

/** One MCP session event the main process pushes into the host tab. */
export type BridgeMcpSinkEvent =
  | { readonly kind: 'sessionOpened'; readonly info: unknown } |
  { readonly kind: 'toolCall'; readonly sessionId: string; readonly toolName: string; readonly args: unknown } |
  {
    readonly kind: 'toolResult';
    readonly sessionId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly isError: boolean;
    readonly json?: unknown;
    readonly images?: readonly ChatImageShape[];
  } |
  { readonly kind: 'clientNotification'; readonly sessionId: string; readonly method: string; readonly params: unknown };

/** One image of a tool result. */
export interface ChatImageShape {
  readonly data: string;
  readonly mimeType: string;
}

/** The core slice: the requests every surface sends to the background worker that owns the app state.
 * The main process relays them into the worker, and the state changes come back as workspace
 * events on the `core.state` channel. */
export interface BridgeCoreApi {
  /**
   * Runs one core request of the shared contract (`src/shared/core-api.ts`).
   *
   * @param channel The request channel.
   * @param payload The payload of the request.
   * @returns The reply value of the worker.
   */
  request(channel: string, payload?: unknown): Promise<unknown>;
  /** Reads the state of the background worker. Null when no worker runs. */
  status(): Promise<CoreStatus | null>;
}

/** The workspace-only slice: the main services and the session tools of the app. */
export interface BridgeWorkspaceApi {
  /** Runs one window tool in the main process as the chat agent principal. The source names the
   * chat whose turn sent the call, so the permission card lands in that chat's tab. */
  runWindowTool(name: string, args: unknown, source?: string): Promise<unknown>;
  /** Applies one MCP endpoint list to the connections of the main process. */
  applyMcpEndpoints(endpoints: unknown): Promise<void>;
  /**
   * Registers the provider base URLs the CORS filter of the main process serves with
   * access-control headers, so the sandboxed page may fetch its inference endpoints.
   */
  allowProviderCors(baseUrls: readonly string[]): Promise<void>;
  /** Reads one resource of the MCP server that lists it. */
  readMcpResource(uri: string): Promise<string>;
  /** Runs one native MCP tool of the connected endpoints. */
  runMcpNativeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Serves one workspace request channel the main process calls. */
  onWorkspaceRequest(handler: (channel: string, payload: unknown) => Promise<unknown>): void;
  /** Subscribes to one event channel the main process pushes. */
  onWorkspaceEvent(channel: string, listener: (payload: unknown) => void): void;
  /** Starts the MCP host after the workspace storage opened. Answers the endpoint, or null without the flag. */
  startMcpHost(): Promise<string | null>;
  /** Reads the MCP host facts for the settings pane. */
  mcpHostInfo(): Promise<{ endpoint: string | null; token: string | null }>;
  /** Notes the share switch state of one frame, which gates every debug attach on its guest. */
  notifyFrameShared(id: number, shared: boolean): Promise<void>;
  /** Closes one frame as the user principal, from the close control of its panel. */
  closeFrameAsUser(id: number): Promise<void>;
}

/** The answer of one plugin entry load in the main process. */
export interface BridgePluginEntry {
  /** The plugin id of the entry. */
  readonly id: string;
  /** The platforms the entry declared, when it declared any. */
  readonly platforms?: readonly string[];
  /** True when the platform filter held the entry out, so nothing registered. */
  readonly skipped: boolean;
  /** The harness documents the entry registered. The plugin manager validates each one. */
  readonly harnessDocs: readonly unknown[];
}

/** The plugin slice: the entries load in the main process, which holds the only require. */
export interface BridgePlugins {
  /** Loads one plugin entry and answers its id, the platform filter result, and its registrations. */
  loadEntry(modulePath: string): Promise<BridgePluginEntry>;
}

/** The full bridge of an app window. */
export interface NodeWavenBridge {
  readonly fs: BridgeFileSystem;
  readonly app: BridgeApp;
  readonly windows: BridgeWindows;
  readonly workspace: BridgeWorkspaceApi;
  readonly plugins: BridgePlugins;
  readonly core: BridgeCoreApi;
}

declare global {
  /** The bridge the preload injects. Undefined in frame guests and plain browsers. */

  var nodewavenui: NodeWavenBridge | undefined;
}

/** Reads the bridge of this app window, or null outside the app. */
export function readBridge(): NodeWavenBridge | null {
  return globalThis.nodewavenui ?? null;
}
