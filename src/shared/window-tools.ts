/**
 * The definitions of the window tools: name, description, and input schema of every tool the
 * MCP host serves and the chat agent carries. The main process attaches the handlers; the
 * workspace page wraps the same definitions over the bridge. One list, two surfaces, no drift.
 */

/** The static definition of one window tool. */
export interface WindowToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Every window tool of the app. */
export const WINDOW_TOOL_DEFINITIONS: readonly WindowToolDefinition[] = [
  {
    name: 'list_windows',
    description: 'Lists the tracked child windows with their ids, URLs, titles, and session states.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_window',
    description:
      'Opens one child window (default 900 x 700) and returns its id. A relative path resolves against the app root. The permission gate may queue an approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The address the window loads. A relative path resolves against the app root.' },
        width: { type: 'integer', description: 'The window width. Default 900.' },
        height: { type: 'integer', description: 'The window height. Default 700.' },
        frame: { type: 'string', enum: ['system', 'borderless'], description: 'The window frame. Omitted, it inherits the frame of the workspace window.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'open_frame',
    description:
      'Opens one embedded frame as a view of the center workspace and returns { frameId, kind, side }. kind iframe loads the address inside the workspace page: it never attaches and carries no debug target of its own. kind webview loads it in its own guest process with its own debug target, and attach_session needs the share switch of its tab on. The permission gate may queue an approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The address the frame loads. A relative path resolves against the app root.' },
        kind: { type: 'string', enum: ['iframe', 'webview'], description: 'The embed kind of the frame.' },
        side: { type: 'string', enum: ['left', 'right'], description: 'Kept for compatibility. Every frame opens in the center workspace; the side picks no column.' },
        title: { type: 'string', description: 'The title the tab shows. Default: the last path segment of the address.' },
      },
      required: ['url', 'kind'],
    },
  },
  {
    name: 'close_window',
    description: 'Closes one child window and stops tracking it. The permission gate may queue an approval request.',
    inputSchema: {
      type: 'object',
      properties: { childId: { type: 'integer', description: 'The id of the child window.' } },
      required: ['childId'],
    },
  },
  {
    name: 'attach_session',
    description:
      'Attaches a debug session to one child window and starts the console capture. Needed for evaluate and screenshot. The permission gate may queue an approval request.',
    inputSchema: {
      type: 'object',
      properties: { childId: { type: 'integer', description: 'The id of the child window.' } },
      required: ['childId'],
    },
  },
  {
    name: 'detach_session',
    description: 'Detaches the debug session of one child window.',
    inputSchema: {
      type: 'object',
      properties: { childId: { type: 'integer', description: 'The id of the child window.' } },
      required: ['childId'],
    },
  },
  {
    name: 'evaluate',
    description:
      'Runs one JavaScript expression in one child window. Requires an attached debug session. A promise result is awaited; objects come back as parsed JSON values. No top-level await: use an async IIFE. The permission gate may queue an approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: 'The id of the child window.' },
        expression: { type: 'string', description: 'The JavaScript source to run. A promise result is awaited.' },
      },
      required: ['childId', 'expression'],
    },
  },
  {
    name: 'screenshot',
    description: 'Captures one screenshot of one child window as base64 image data. Requires an attached session.',
    inputSchema: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: 'The id of the child window.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'The image format. Default png.' },
      },
      required: ['childId'],
    },
  },
  {
    name: 'console_entries',
    description: 'Reads the captured console lines of one child window since the attach or the last clear.',
    inputSchema: {
      type: 'object',
      properties: { childId: { type: 'integer', description: 'The id of the child window.' } },
      required: ['childId'],
    },
  },
  {
    name: 'clear_console',
    description: 'Clears the captured console of one child window.',
    inputSchema: {
      type: 'object',
      properties: { childId: { type: 'integer', description: 'The id of the child window.' } },
      required: ['childId'],
    },
  },
  {
    name: 'navigate',
    description: 'Loads one address in one child window. The permission gate may queue an approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: 'The id of the child window.' },
        url: { type: 'string', description: 'The address to load.' },
      },
      required: ['childId', 'url'],
    },
  },
  {
    name: 'open_devtools',
    description: 'Opens the DevTools window of one child window.',
    inputSchema: {
      type: 'object',
      properties: { childId: { type: 'integer', description: 'The id of the child window.' } },
      required: ['childId'],
    },
  },
];

/** One content block of a tool result: text, or an image with its data and mime type. */
export type McpContentBlock = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** One tool result of the window tools. */
export interface McpToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/** The facts of one MCP host connection, for the connection post of the host tab. */
export interface McpConnectionInfo {
  readonly clientName: string | null;
  readonly clientVersion: string | null;
  readonly protocolVersion: string | null;
  readonly userAgent: string | null;
}

/** The handle of the running MCP host, for the settings pane. */
export interface McpHostHandle {
  /** The HTTP endpoint of the host. */
  readonly endpoint: string;
  /** Reads the access token for the settings pane reveal. */
  readAccessToken(): string;
}

/** Receives the session lifecycle and the tool traffic of the host, so the app can log it into chat tabs. */
export interface McpSessionSink {
  sessionOpened(sessionId: string, info: McpConnectionInfo): void;
  toolCall(sessionId: string, toolName: string, args: Record<string, unknown>): void;
  toolResult(
    sessionId: string,
    toolName: string,
    summary: string,
    isError: boolean,
    json?: unknown,
    images?: readonly unknown[],
  ): void;
  clientNotification(sessionId: string, method: string, params: unknown): void;
}
