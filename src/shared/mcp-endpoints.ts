/**
 * The MCP endpoint configuration: the remote servers the app connects to as an MCP client.
 * The endpoint list persists in the `mcp-endpoints` record of the workspace storage.
 */

/** How one endpoint surfaces its tools to the chat agent. */
export type McpEndpointMode = 'native' | 'preloaded' | 'none' | 'disabled';

/** The transport of one endpoint. */
export type McpEndpointTransport =
  | { readonly kind: 'http'; readonly url: string; readonly token?: string }
  | { readonly kind: 'stdio'; readonly command: string; readonly args?: readonly string[] };

/** One configured MCP server endpoint. */
export interface McpEndpoint {
  readonly id: string;
  readonly label: string;
  readonly transport: McpEndpointTransport;
  readonly mode: McpEndpointMode;
}

/** The persisted endpoint list of the workspace. */
export interface McpEndpoints {
  readonly endpoints: readonly McpEndpoint[];
}

const ENDPOINT_MODES: ReadonlySet<string> = new Set(['native', 'preloaded', 'none', 'disabled']);

function isTransport(value: unknown): value is McpEndpointTransport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'http') {
    return (
      typeof candidate.url === 'string' &&
      candidate.url.length > 0 &&
      (candidate.token === undefined || typeof candidate.token === 'string')
    );
  }
  if (candidate.kind === 'stdio') {
    return (
      typeof candidate.command === 'string' &&
      candidate.command.length > 0 &&
      (candidate.args === undefined ||
        (Array.isArray(candidate.args) && candidate.args.every((arg) => typeof arg === 'string')))
    );
  }
  return false;
}

/**
 * Checks that a value is a valid McpEndpoint.
 * Use this guard where the endpoint list arrives without type backing, above all from the persisted record.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value satisfies the endpoint shape.
 */
export function isMcpEndpoint(value: unknown): value is McpEndpoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    isTransport(candidate.transport) &&
    typeof candidate.mode === 'string' &&
    ENDPOINT_MODES.has(candidate.mode)
  );
}

/**
 * Checks that a value is a valid McpEndpoints record.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value satisfies the record shape.
 */
export function isMcpEndpoints(value: unknown): value is McpEndpoints {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.endpoints) && candidate.endpoints.every((endpoint) => isMcpEndpoint(endpoint));
}

/**
 * Sanitizes one endpoint label into a tool name prefix: lowercase letters, digits, and dashes.
 * The prefix joins the tool name with a dot, so saved child-window code can address the tools programmatically.
 *
 * @param label The label to sanitize.
 * @returns The sanitized prefix, or "mcp" when the label holds no usable character.
 */
export function sanitizeEndpointLabel(label: string): string {
  const sanitized = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return sanitized.length > 0 ? sanitized : 'mcp';
}
