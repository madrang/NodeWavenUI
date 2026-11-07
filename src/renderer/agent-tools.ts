/**
 * The tools of the chat agent. The registry joins the built-ins (`evaluate`, `read`) with the window
 * tools the MCP host serves, and with the native tools of the connected MCP endpoints, named
 * `<sanitized-label>.<tool>`.
 * The `evaluate` tool wraps the same window-manager call the MCP host uses, with the `agent` principal,
 * so it runs in child windows only unless `--expose-main-window` was passed at launch.
 */

import type { ChatImage, ToolDefinition } from '../providers/provider.js';
import type { PermissionRule, PrincipalKind, PermissionTarget } from '../shared/permissions.js';
import { readHarnessDoc } from './doc-resources.js';
import { fileSystem } from './file-system.js';
import { createTools, type McpToolResult } from './mcp-host.js';
import type { McpClientManager } from './mcp-client/manager.js';
import type { FrameManager } from './frames.js';
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
    preauthorized?: boolean,
  ): Promise<void>;
}

/** The origin the chat agent's permission requests carry, so the chat pane routes them. */
export const CHAT_AGENT_SOURCE = 'chat-agent';

/** The caller every chat-agent tool acts as. */
const CHAT_AGENT_CALLER: WindowCaller = { principal: 'agent', source: CHAT_AGENT_SOURCE };

/** The caller of a tool whose allow rule already covered the call, so the ask defaults of the window
 * checks turn into allow. Deny rules at the window layer still block. */
const PREAUTHORIZED_AGENT_CALLER: WindowCaller = { principal: 'agent', source: CHAT_AGENT_SOURCE, preauthorized: true };

/**
 * Reads the first rule that governs one agent tool: resource `tool`, the agent principal, the tool name.
 * The rule list comes from the permission gate, so the matrix and the request cards write the same rules.
 *
 * @param name The tool name, for example `read` or `obsidian.read_note`.
 * @param rules The permission rules, in evaluation order.
 * @returns The rule, or null when none governs the tool, which leaves the tool on ask.
 */
export function agentToolRule(name: string, rules: readonly PermissionRule[]): PermissionRule | null {
  for (const rule of rules) {
    if (!rule.enabled || rule.resource !== 'tool') {
      continue;
    }
    if (rule.principal !== 'agent' && rule.principal !== '*') {
      continue;
    }
    if (rule.actions !== '*' && !rule.actions.includes(name)) {
      continue;
    }
    return rule;
  }
  return null;
}

/** True when a deny rule governs the tool, so the agent list hides it. */
function toolDenied(name: string, rules: readonly PermissionRule[]): boolean {
  return agentToolRule(name, rules)?.effect === 'deny';
}

/** One tool result: the text the model reads and the images a vision model sees. */
export interface AgentToolOutput {
  readonly text: string;
  readonly images?: readonly ChatImage[];
}

/** One tool the chat agent may call. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<AgentToolOutput>;
}

/** The dependencies the built-in tools need. */
export interface AgentToolDeps {
  readonly windowManager: ChildWindowManager;
  readonly gate: PermissionCheck;
  readonly mcpClients: McpClientManager;
  /** The frame tiling manager. Null pages serve no open_frame tool. */
  readonly frames: FrameManager | null;
  /** The absolute path of the workspace directory. `read` serves file URIs inside it only. */
  readonly workspacePath: string;
  /** The storage sharing of the workspace. `read` serves the storages shared read-only. */
  readonly storageShares: StorageShareRegistry;
  /** Reads the permission rules, so the tool rules decide the ask, allow, and disable states. */
  readonly toolRules: () => readonly PermissionRule[];
}

function readWorkspaceFile(path: string): string {
  const nodeFs = fileSystem();
  if (nodeFs === null) {
    throw new Error('The filesystem is not reachable. Start the app under NW.js.');
  }
  return nodeFs.readFileSync(path, 'utf-8');
}

/** Reads one file URI, after the permission pipeline allows the path. An allow rule on the read tool
 * preauthorizes the check, so it prompts no more, but a deny rule still blocks the file. */
async function readFileUri(uri: string, deps: AgentToolDeps, preauthorized: boolean): Promise<string> {
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
  await deps.gate.check(
    'agent',
    'read',
    { kind: 'file', path: decoded },
    `file ${decoded}`,
    CHAT_AGENT_SOURCE,
    preauthorized,
  );
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
        return { text: await readHarnessDoc(uri) };
      }
      if (uri.startsWith('file:')) {
        const preauthorized = agentToolRule('read', deps.toolRules())?.effect === 'allow';
        return { text: await readFileUri(uri, deps, preauthorized) };
      }
      if (uri.startsWith('storage:')) {
        return { text: await readStorageUri(uri, deps) };
      }
      return { text: await deps.mcpClients.readResource(uri) };
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
      // An allow rule on the evaluate tool preauthorizes the window check, so the call never prompts twice.
      const caller =
        agentToolRule('evaluate', deps.toolRules())?.effect === 'allow' ? PREAUTHORIZED_AGENT_CALLER : CHAT_AGENT_CALLER;
      const result = await deps.windowManager.evaluate(caller, childId, expression);
      return { text: JSON.stringify(result) };
    },
  };
}

/** Renders one window tool result as the output the chat agent reads: the text blocks and the image blocks. */
function windowToolOutput(result: McpToolResult): AgentToolOutput {
  const parts: string[] = [];
  const images: ChatImage[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else {
      images.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return { text: parts.join('\n'), ...(images.length > 0 ? { images } : {}) };
}

/**
 * Builds the tool list of the chat agent: the built-ins, the window tools of the MCP host, and the
 * native tools of the connected endpoints. A deny rule on a tool keeps it out of the list, so the
 * provider never sees it.
 *
 * @param deps The window manager, the permission gate, the MCP client manager, and the workspace storage facts.
 * @returns The tools, in build order, without the disabled ones.
 */
export function buildAgentTools(deps: AgentToolDeps): readonly AgentTool[] {
  return availableAgentTools(deps).filter((tool) => !toolDenied(tool.name, deps.toolRules()));
}

/** The full tool list of the chat agent, disabled tools included, for the settings matrix. */
export function availableAgentTools(deps: AgentToolDeps): readonly AgentTool[] {
  const tools: AgentTool[] = [createEvaluateTool(deps), createReadTool(deps)];
  // The chat agent carries the same window tools the MCP host serves, acting as the agent principal.
  // The built-in evaluate above covers the host evaluate, so its descriptor is skipped.
  // A page without the frame columns serves no open_frame.
  for (const descriptor of createTools(deps.windowManager, deps.frames)) {
    if (descriptor.name === 'evaluate') {
      continue;
    }
    if (descriptor.name === 'open_frame' && !deps.frames) {
      continue;
    }
    tools.push({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      run: (args) => {
        // An allow rule on the tool preauthorizes its window checks, so one call never prompts twice.
        const caller =
          agentToolRule(descriptor.name, deps.toolRules())?.effect === 'allow'
            ? PREAUTHORIZED_AGENT_CALLER
            : CHAT_AGENT_CALLER;
        return descriptor.handler(args, caller).then(windowToolOutput);
      },
    });
  }
  for (const native of deps.mcpClients.nativeTools()) {
    tools.push({
      name: native.name,
      description: native.description,
      inputSchema: native.inputSchema,
      run: async (args) => {
        // The tool rule decides: allow runs direct, anything else asks through the gate.
        if (agentToolRule(native.name, deps.toolRules())?.effect !== 'allow') {
          await deps.gate.check(
            'agent',
            native.name,
            { kind: 'tool', name: native.name },
            `native MCP tool ${native.name}`,
            CHAT_AGENT_SOURCE,
          );
        }
        const result = await deps.mcpClients.runNativeTool(native.name, args);
        return {
          text: result.isError ? `The tool reported an error: ${result.text}` : result.text,
          ...(result.images.length > 0 ? { images: result.images } : {}),
        };
      },
    });
  }
  return tools;
}

/** Reads one agent tool as the wire definition the provider sends. */
export function agentToolDefinition(tool: AgentTool): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
