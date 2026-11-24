/**
 * The chat agent tool calls of the main process, through one entry for both callers: the ipc
 * handler of the workspace page, and the worker core, whose chat engine reaches the services that
 * stayed in main through the calls it sends over its port.
 */

import type { CoreReply } from '../shared/core-api.js';
import { readMainCall } from '../shared/core-api.js';
import { CHAT_AGENT_SOURCE } from '../shared/permissions.js';
import { asRecord, isRecord } from '../shared/records.js';
import { mcpNativeTools, readMcpResource, runMcpNativeTool } from './mcp-client-service.js';
import { createTools, type McpToolResult } from './mcp-host.js';

/**
 * Runs one window or command tool of the main process as the chat agent principal, so the same
 * permission cards and rules govern it as on the MCP host.
 *
 * @param name The tool name.
 * @param args The arguments of the call.
 * @param source The origin the permission check attributes its request to. An empty source reads as
 * the bare chat agent, so the card lands in the active chat tab.
 * @returns The tool result.
 * @throws Error when no tool carries the name.
 */
export async function runChatAgentTool(
  name: string,
  args: Record<string, unknown>,
  source: string | null,
): Promise<McpToolResult> {
  const tool = createTools().find((descriptor) => descriptor.name === name);
  if (!tool) {
    throw new Error(`The tool "${name}" is unknown.`);
  }
  return tool.handler(args, { principal: 'agent', source: source && source.length > 0 ? source : CHAT_AGENT_SOURCE });
}

/**
 * Serves one call the worker core sent, and shapes the answer as the reply its call waits for.
 * A refused call answers with the error in place, so the engine of the worker reads the failure.
 *
 * @param value The call message of the worker. It can have any type.
 * @returns The reply of the call.
 */
export async function serveWorkerCall(value: unknown): Promise<CoreReply> {
  // An invalid call still answers under its id, when it carries one, so no engine call waits forever.
  const id = isRecord(value) && typeof value.id === 'number' ? value.id : 0;
  const call = readMainCall(value);
  if (!call) {
    return { id, ok: false, error: 'The call of the worker core carries an invalid shape or an unknown channel.' };
  }
  const payload = asRecord(call.payload) ?? {};
  try {
    let result: unknown;
    switch (call.channel) {
      case 'windowTool': {
        if (typeof payload.name !== 'string') {
          throw new Error('The window tool call needs a name string.');
        }
        result = await runChatAgentTool(payload.name, asRecord(payload.args) ?? {}, typeof payload.source === 'string' ? payload.source : null);
        break;
      }
      case 'mcp.nativeTools': {
        result = mcpNativeTools();
        break;
      }
      case 'mcp.runNativeTool': {
        if (typeof payload.name !== 'string') {
          throw new Error('The native tool call needs a name string.');
        }
        result = await runMcpNativeTool(payload.name, asRecord(payload.args) ?? {});
        break;
      }
      case 'mcp.readResource': {
        if (typeof payload.uri !== 'string' || payload.uri.length === 0) {
          throw new Error('The resource read needs a uri string.');
        }
        result = await readMcpResource(payload.uri);
        break;
      }
    }
    return { id: call.id, ok: true, value: result };
  } catch (error) {
    return { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
