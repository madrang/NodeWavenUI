/**
 * The tools of the chat agent. The registry joins the built-in `read` tool with the window
 * tools the main process serves over the bridge, and with the native tools of the connected
 * MCP endpoints, named `<sanitized-label>.<tool>`.
 * Every window tool runs in the main process with the `agent` principal, so the same
 * permission cards and rules govern it.
 */

import type { ChatImage, ToolDefinition } from '../providers/provider.js';
import type { PermissionRule, PrincipalKind, PermissionTarget } from '../shared/permissions.js';
import { CHAT_AGENT_SOURCE, matchingRule } from '../shared/permissions.js';
import { readBridge } from '../shared/bridge.js';
import type { PathRule } from '../shared/permissions.js';
import { COMMAND_TOOL_DEFINITIONS } from '../shared/command-tool.js';
import { WINDOW_TOOL_DEFINITIONS } from '../shared/window-tools.js';
import { harnessFolderListing, KNOWN_PATHS_URI, knownPathsDocument, readHarnessDoc } from './doc-resources.js';
import { readTextFile } from './file-system.js';
import { createFileTools, type FileToolDeps } from './file-tools.js';
import { createTasksTool, type TaskToolDeps } from './task-tools.js';
import type { PatchStore } from './patch-store.js';
import type { McpToolResult } from '../shared/window-tools.js';
import type { McpClientSurface } from './mcp-client-adapter.js';
import type { StorageShareRegistry } from './storage-shares.js';

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

export { CHAT_AGENT_SOURCE };

/**
 * Reads the first rule that governs one agent tool: resource `tool`, the agent principal, the tool name.
 * The shared matcher of the permission model decides, and the rule list comes from the permission
 * gate, so the matrix and the request cards read the rules the gate reads.
 *
 * @param name The tool name, for example `read` or `obsidian.read_note`.
 * @param rules The permission rules, in evaluation order.
 * @returns The rule, or null when none governs the tool, which leaves the tool on ask.
 */
export function agentToolRule(name: string, rules: readonly PermissionRule[]): PermissionRule | null {
  return matchingRule('agent', name, { kind: 'tool', name }, rules);
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
  readonly gate: PermissionCheck;
  readonly mcpClients: McpClientSurface;
  /** The absolute path of the workspace directory. `read` serves file URIs inside it only. */
  readonly workspacePath: string;
  /** The storage sharing of the workspace. `read` serves the storages shared read-only. */
  readonly storageShares: StorageShareRegistry;
  /** Reads the permission rules, so the tool rules decide the ask, allow, and disable states. */
  readonly toolRules: () => readonly PermissionRule[];
  /** The source the permission checks of this tool set attribute their requests to, scoped to the
   * chat whose turn runs them, so the approval card lands in that chat's tab. */
  readonly source: string;
  /** The numeric id of the chat whose turn builds the tools, for the file tools. */
  readonly chatId: number;
  /** The session file id of that chat, the patch identity that survives restores. */
  readonly sessionFileId: string | null;
  /** The patch store that holds every write proposal of the agent. */
  readonly patchStore: PatchStore;
  /** Reads the known paths of the workspace, which grant or refuse agent access per path. */
  readonly pathRules: () => readonly PathRule[];
  /** The deps of the tasks tool, when the workspace wires the task store. Without it the tool stays out. */
  readonly tasks?: TaskToolDeps;
}

async function readWorkspaceFile(path: string): Promise<string> {
  const text = await readTextFile(path);
  // eslint-disable-next-line local/prefer-truthiness -- an empty file reads as an empty string, only a failed read throws
  if (text === null) {
    throw new Error(`The file ${path} could not be read.`);
  }
  return text;
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
    deps.source,
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

/** Builds the `read` tool. Exported for the specs. */
export function createReadTool(deps: AgentToolDeps): AgentTool {
  return {
    name: 'read',
    description:
      'Reads one URI. harness:///nodewavenui/overview.md starts the app documentation, harness:///nodewavenui/known-paths.md lists the registered path rules, and a harness folder URI with its trailing slash lists its documents and subfolders, file:// reads a workspace file and asks on first use, storage://<storageId>/<key> reads a storage the user shared read-only, and any other scheme goes to the MCP server that lists the resource. See harness:///nodewavenui/read-uris.md.',
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
        // The known-paths document renders from the live rules, so it answers with the registered
        // state of the moment instead of a shipped file.
        if (uri === KNOWN_PATHS_URI) {
          return { text: knownPathsDocument(deps.pathRules()) };
        }
        const folder = harnessFolderListing(uri);
        if (folder) {
          return { text: folder };
        }
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

/** Builds one window tool of the chat agent: the shared definition wrapped over the bridge. The
 * main process runs it as the agent principal and attributes its permission check to the source. */
function createWindowTool(
  definition: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
  },
  source: string,
): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    run: async (args) => {
      const bridge = readBridge();
      if (!bridge) {
        throw new Error('The window tools need the nodewavenui bridge of an app window.');
      }
      const result = (await bridge.workspace.runWindowTool(definition.name, args, source)) as McpToolResult | null;
      if (!result || typeof result !== 'object') {
        throw new Error(`The tool "${definition.name}" returned no result.`);
      }
      if (result.isError) {
        const text = result.content.find((block) => block.type === 'text')?.text ?? 'The tool failed.';
        throw new Error(text);
      }
      return windowToolOutput(result);
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
 * Builds the tool list of the chat agent: the built-in `read` tool, the window tools of the
 * main process, and the native tools of the connected endpoints. A deny rule on a tool keeps
 * it out of the list, so the provider never sees it.
 *
 * @param deps The permission gate, the MCP client manager, and the workspace storage facts.
 * @returns The tools, in build order, without the disabled ones.
 */
export function buildAgentTools(deps: AgentToolDeps): readonly AgentTool[] {
  return availableAgentTools(deps).filter((tool) => !toolDenied(tool.name, deps.toolRules()));
}

/** The full tool list of the chat agent, disabled tools included, for the settings matrix. */
export function availableAgentTools(deps: AgentToolDeps): readonly AgentTool[] {
  const tools: AgentTool[] = [createReadTool(deps)];
  // The file tool set runs in the workspace page: reads over the bridge fs after the permission
  // pipeline, writes as patch proposals the user reviews, tasks as the naming surface.
  const fileDeps: FileToolDeps = {
    check: deps.gate,
    workspacePath: deps.workspacePath,
    chatId: deps.chatId,
    sessionFileId: deps.sessionFileId,
    source: deps.source,
    store: deps.patchStore,
    pathRules: deps.pathRules,
  };
  tools.push(...createFileTools(fileDeps));
  // The task records join the list only when main-app wired the store and the session callbacks.
  if (deps.tasks) {
    tools.push(createTasksTool(deps.tasks));
  }
  // The chat agent carries the same window and command tools the MCP host serves, acting as the agent principal.
  for (const definition of [...WINDOW_TOOL_DEFINITIONS, ...COMMAND_TOOL_DEFINITIONS]) {
    tools.push(createWindowTool(definition, deps.source));
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
            deps.source,
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
