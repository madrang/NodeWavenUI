/**
 * The tools of the chat agent. The registry joins the built-ins (`evaluate`, `read`) with the window
 * tools the MCP host serves, and with the native tools of the connected MCP endpoints, named
 * `<sanitized-label>.<tool>`.
 * The `evaluate` tool wraps the same window-manager call the MCP host uses, with the `agent` principal,
 * so it runs in child windows only unless `--expose-main-window` was passed at launch.
 */

import type { ToolDefinition } from '../providers/provider.js';
import type { PrincipalKind, PermissionTarget } from '../shared/permissions.js';
import { readHarnessDoc } from './doc-resources.js';
import { fileSystem } from './file-system.js';
import { createTools, type McpToolResult } from './mcp-host.js';
import type { McpClientManager } from './mcp-client/manager.js';
import type { StorageShareRegistry } from './storage-shares.js';
import type { ChildWindowManager, WindowCaller } from './window-manager.js';

/** The permission check the tools need. The PermissionGate of the workspace implements it. */
export interface PermissionCheck {
  check(
    principal: PrincipalKind,
    action: string,
    target: PermissionTarget,
    detail: string,
    source?: string | null,
  ): Promise<void>;
}

/** The origin the chat agent's permission requests carry, so the chat pane routes them. */
export const CHAT_AGENT_SOURCE = 'chat-agent';

/** The caller every chat-agent tool acts as. */
const CHAT_AGENT_CALLER: WindowCaller = { principal: 'agent', source: CHAT_AGENT_SOURCE };

/** One tool the chat agent may call. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

/** The dependencies the built-in tools need. */
export interface AgentToolDeps {
  readonly windowManager: ChildWindowManager;
  readonly gate: PermissionCheck;
  readonly mcpClients: McpClientManager;
  /** The absolute path of the workspace directory. `read` serves file URIs inside it only. */
  readonly workspacePath: string;
  /** The storage sharing of the workspace. `read` serves the storages shared read-only. */
  readonly storageShares: StorageShareRegistry;
}

function readWorkspaceFile(path: string): string {
  const nodeFs = fileSystem();
  if (nodeFs === null) {
    throw new Error('The filesystem is not reachable. Start the app under NW.js.');
  }
  return nodeFs.readFileSync(path, 'utf-8');
}

/** Reads one file URI, after the permission pipeline allows the path. */
async function readFileUri(uri: string, deps: AgentToolDeps): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(uri).pathname);
  } catch {
    throw new Error(`The URI ${uri} is not a valid file URI.`);
  }
  const root = deps.workspacePath.replace(/[\\/]+$/, '');
  if (decoded !== root && !decoded.startsWith(`${root}/`)) {
    throw new Error(`The file ${decoded} lies outside the workspace ${root}. The read tool serves workspace files only.`);
  }
  await deps.gate.check('agent', 'read', { kind: 'file', path: decoded }, `file ${decoded}`, CHAT_AGENT_SOURCE);
  return readWorkspaceFile(decoded);
}

/** Reads one storage URI. The storage sharing settings carry the grant, so no request card shows. */
async function readStorageUri(uri: string, deps: AgentToolDeps): Promise<string> {
  const rest = uri.slice('storage://'.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) {
    throw new Error('A storage URI needs the form storage://<storageId>/<key>.');
  }
  const storageId = rest.slice(0, separator);
  const key = rest.slice(separator + 1);
  const value = await deps.storageShares.readKey(storageId, key);
  return value ?? `(the record "${key}" is empty)`;
}

function createReadTool(deps: AgentToolDeps): AgentTool {
  return {
    name: 'read',
    description:
      'Reads one URI. harness:///nodewavenui/overview.md starts the app documentation, file:// reads a workspace file and asks on first use, storage://<storageId>/<key> reads a storage the user shared read-only, and any other scheme goes to the MCP server that lists the resource. See harness:///nodewavenui/read-uris.md.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'The URI to read, for example file:///home/user/note.md.' },
      },
      required: ['uri'],
      additionalProperties: false,
    },
    run: async (args) => {
      const uri = typeof args.uri === 'string' ? args.uri : '';
      if (uri.length === 0) {
        throw new Error('The read tool needs a uri string.');
      }
      if (uri.startsWith('harness:')) {
        return readHarnessDoc(uri);
      }
      if (uri.startsWith('file:')) {
        return readFileUri(uri, deps);
      }
      if (uri.startsWith('storage:')) {
        return readStorageUri(uri, deps);
      }
      return deps.mcpClients.readResource(uri);
    },
  };
}

function createEvaluateTool(deps: AgentToolDeps): AgentTool {
  return {
    name: 'evaluate',
    description:
      'Evaluates one JavaScript expression in one child window. Requires an attached debug session. The page global nodewavenMcp reaches the MCP endpoints of the app. The first use on one window asks for permission.',
    inputSchema: {
      type: 'object',
      properties: {
        childId: { type: 'integer', description: 'The id of the child window.' },
        expression: { type: 'string', description: 'The JavaScript source to run. A promise result is awaited.' },
      },
      required: ['childId', 'expression'],
      additionalProperties: false,
    },
    run: async (args) => {
      const childId = args.childId;
      const expression = args.expression;
      if (typeof childId !== 'number' || !Number.isInteger(childId)) {
        throw new Error('The evaluate tool needs a childId integer.');
      }
      if (typeof expression !== 'string' || expression.length === 0) {
        throw new Error('The evaluate tool needs an expression string.');
      }
      deps.windowManager.ensurePageGlobals(childId);
      const result = await deps.windowManager.evaluate(CHAT_AGENT_CALLER, childId, expression);
      return JSON.stringify(result);
    },
  };
}

/** Renders one window tool result as the text the chat agent reads. Image data stays out of the chat. */
function windowToolText(result: McpToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else {
      parts.push(`[${block.mimeType} image, ${block.data.length} characters of base64 data omitted]`);
    }
  }
  return parts.join('\n');
}

/**
 * Builds the tool list of the chat agent: the built-ins, the window tools of the MCP host, and the
 * native tools of the connected endpoints.
 *
 * @param deps The window manager, the permission gate, the MCP client manager, and the workspace storage facts.
 * @returns The tools, in build order.
 */
export function buildAgentTools(deps: AgentToolDeps): readonly AgentTool[] {
  const tools: AgentTool[] = [createEvaluateTool(deps), createReadTool(deps)];
  // The chat agent carries the same window tools the MCP host serves, acting as the agent principal.
  // The built-in evaluate above covers the host evaluate, so its descriptor is skipped.
  for (const descriptor of createTools(deps.windowManager)) {
    if (descriptor.name === 'evaluate') {
      continue;
    }
    tools.push({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      run: (args) => descriptor.handler(args, CHAT_AGENT_CALLER).then(windowToolText),
    });
  }
  for (const native of deps.mcpClients.nativeTools()) {
    tools.push({
      name: native.name,
      description: native.description,
      inputSchema: native.inputSchema,
      run: (args) =>
        deps.mcpClients
          .runNativeTool(native.name, args)
          .then((result) => (result.isError ? `The tool reported an error: ${result.text}` : result.text)),
    });
  }
  return tools;
}

/** Reads one agent tool as the wire definition the provider sends. */
export function agentToolDefinition(tool: AgentTool): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
