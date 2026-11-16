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
    name: 'list_pages',
    description: 'Lists the tracked pages with their ids, URLs, titles, and session states.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_uri',
    description: 'Opens one address as a page of the app: a frame of the center workspace or an OS window.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The address to open. A relative path resolves against the app root.' },
        kind: { type: 'string', enum: ['iframe', 'webview', 'window'], default: 'webview', description: 'How the address opens. iframe loads it inside the workspace page: it never attaches and carries no debug target of its own. webview loads it in its own guest process with its own debug target, and attach_session needs the share switch of its tab on. window opens a separate OS window.' },
        title: { type: 'string', description: 'The title the frame tab shows. Frame kinds only.' },
        width: { type: 'integer', default: 900, description: 'The window width. Kind window only.' },
        height: { type: 'integer', default: 700, description: 'The window height. Kind window only.' },
        frame: { type: 'string', enum: ['system', 'borderless'], description: 'The window frame. Kind window only. Omitted, it inherits the frame of the workspace window.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'close_page',
    description: 'Closes one page and stops tracking it.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'integer', description: 'The id of the page.' } },
      required: ['pageId'],
    },
  },
  {
    name: 'attach_session',
    description: 'Attaches a debug session to one page and starts the console capture. Needed for evaluate and screenshot.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'integer', description: 'The id of the page.' } },
      required: ['pageId'],
    },
  },
  {
    name: 'detach_session',
    description: 'Detaches the debug session of one page.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'integer', description: 'The id of the page.' } },
      required: ['pageId'],
    },
  },
  {
    name: 'evaluate',
    description:
      'Runs one JavaScript expression in one page. Requires an attached debug session. A promise result is awaited; objects come back as parsed JSON values. No top-level await: use an async IIFE.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'integer', description: 'The id of the page.' },
        expression: { type: 'string', description: 'The JavaScript source to run. A promise result is awaited.' },
      },
      required: ['pageId', 'expression'],
    },
  },
  {
    name: 'screenshot',
    description: 'Captures one screenshot of one page as base64 image data. Requires an attached session.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'integer', description: 'The id of the page.' },
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'png', description: 'The image format.' },
      },
      required: ['pageId'],
    },
  },
  {
    name: 'console_entries',
    description: 'Reads the captured console lines of one page since the attach or the last clear.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'integer', description: 'The id of the page.' } },
      required: ['pageId'],
    },
  },
  {
    name: 'clear_console',
    description: 'Clears the captured console of one page.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'integer', description: 'The id of the page.' } },
      required: ['pageId'],
    },
  },
  {
    name: 'navigate',
    description: 'Loads one address in one page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'integer', description: 'The id of the page.' },
        url: { type: 'string', description: 'The address to load.' },
      },
      required: ['pageId', 'url'],
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
