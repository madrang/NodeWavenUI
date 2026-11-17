/**
 * The `tasks` tool of the chat agent: one surface over both task concepts, named in the plural
 * like `files`. The `name` action is the naming surface of the chat: it renames the tab, groups
 * the patch events, and feeds the later commit title. Every other action serves the dispatchable
 * task records. The completion signal lives here as an action, not in the end of a turn: the
 * session agent calls complete when its goal holds, and the task waits for the user review.
 */

import type { AgentTool, AgentToolOutput } from './agent-tools.js';
import { taskSettlesWaiter, type TaskDispatchMode, type TaskRecord, type TaskStatus } from '../shared/tasks.js';
import type { TaskStore } from './task-store.js';

/** The permission check shape the tool needs, kept local so the interface of agent-tools stays closed. */
export interface TaskToolCheck {
  check(principal: 'agent', action: string, target: { kind: 'tool'; name: string }, detail: string, source?: string | null): Promise<void>;
}

/** The dependencies the task tool needs. */
export interface TaskToolDeps {
  /** The task store of the workspace. */
  readonly store: TaskStore;
  /** Opens or binds the chat session of one dispatch. Answers the outcome text for the agent. */
  readonly dispatch: (id: string, mode: TaskDispatchMode, sessionFileId: string | null) => Promise<string>;
  /** Delivers one message into the task session. Answers the outcome text for the agent. */
  readonly send: (id: string, message: string) => Promise<string>;
  /** Names the work of the chat: the patch-group naming surface. Answers the outcome text. */
  readonly setTaskName: (title: string | null, description: string | null, amend: boolean) => Promise<string>;
  /** The chat id whose turn runs the tool, for the origin records and the guards. */
  readonly chatId: number;
  /** The permission check the dispatch action asks through. */
  readonly check: TaskToolCheck;
  /** Reads whether an allow rule preauthorizes the tasks tool, so the dispatch asks no card. */
  readonly dispatchAllowed: () => boolean;
  /** The source the permission check attributes its request to. */
  readonly source: string;
}

/** Reads one optional string argument. */
function optionalString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads one required string argument. */
function requireString(args: Record<string, unknown>, name: string): string {
  const value = optionalString(args, name);
  if (!value) {
    throw new Error(`The argument "${name}" needs a non-empty string.`);
  }
  return value;
}

/** Reads one id argument. */
function requireId(args: Record<string, unknown>): string {
  return requireString(args, 'id');
}

/** Reads one optional string list argument. */
function optionalStringList(args: Record<string, unknown>, name: string): string[] | null {
  const value = args[name];
  if (!Array.isArray(value)) {
    return null;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`The argument "${name}" needs non-empty strings only.`);
    }
    items.push(item);
  }
  return items;
}

/** Renders one record as the one-line form the list action shows. */
function taskLine(task: TaskRecord): string {
  const blocked = task.blockedBy.length > 0 ? ` blockedBy ${task.blockedBy.join(',')}` : '';
  const session = task.sessionFileId ? ` session ${task.sessionFileId}` : '';
  return `${task.id} [${task.status}]${task.goal ? ' (goal)' : ''}${blocked}${session} ${task.title}`;
}

/** Renders one record whole, for the read action and the settle answers of the wait. */
function taskDetail(task: TaskRecord): string {
  const rows = [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `origin: ${task.origin}${task.originChatId ? ` chat ${task.originChatId}` : ''}`,
    `parent: ${task.parentTaskId ?? 'none'}`,
    `blockedBy: ${task.blockedBy.length > 0 ? task.blockedBy.join(', ') : 'none'}`,
    `session: ${task.sessionFileId ?? 'none'}`,
  ];
  if (task.description) {
    rows.push(`description: ${task.description}`);
  }
  if (task.goal) {
    rows.push(`goal: ${task.goal}`);
  }
  if (task.result) {
    rows.push(`result: ${task.result}`);
  }
  if (task.evidence) {
    rows.push(`evidence: ${task.evidence}`);
  }
  if (task.note) {
    rows.push(`note: ${task.note}`);
  }
  rows.push(`created: ${task.createdAt}`);
  if (task.dispatchedAt) {
    rows.push(`dispatched: ${task.dispatchedAt}`);
  }
  if (task.settledAt) {
    rows.push(`settled: ${task.settledAt}`);
  }
  return rows.join('\n');
}

/** Reads the record of one id argument, or throws the miss. */
function recordOf(deps: TaskToolDeps, id: string): TaskRecord {
  const record = deps.store.get(id);
  if (!record) {
    throw new Error(`The task ${id} does not exist.`);
  }
  return record;
}

/** Runs the name action: the patch-group naming surface of the chat. */
async function runName(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const amend = args['amend'] === true;
  return { text: await deps.setTaskName(optionalString(args, 'title'), optionalString(args, 'description'), amend) };
}

/** Runs the create action. */
async function runCreate(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const record = await deps.store.create({
    title: requireString(args, 'title'),
    description: optionalString(args, 'description'),
    goal: optionalString(args, 'goal'),
    origin: 'agent',
    originChatId: deps.chatId,
    parentTaskId: optionalString(args, 'parentTaskId'),
    blockedBy: optionalStringList(args, 'blockedBy') ?? [],
  });
  if (!record) {
    const blocked = optionalStringList(args, 'blockedBy') ?? [];
    throw new Error(`The blockedBy list names a task that does not exist: ${blocked.join(', ')}.`);
  }
  return { text: `Task ${record.id} created as a draft: ${record.title}. The user dispatches it from the task board, or you dispatch it with action dispatch.` };
}

/** Runs the dispatch action. An allow rule on the tasks tool preauthorizes it. */
async function runDispatch(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const mode = args['mode'] === 'session' ? 'session' : 'new-session';
  const sessionFileId = mode === 'session' ? requireString(args, 'sessionFileId') : null;
  if (!deps.dispatchAllowed()) {
    await deps.check.check('agent', 'tasks', { kind: 'tool', name: 'tasks' }, `dispatch task ${id} (${mode})`, deps.source);
  }
  const record = await deps.store.dispatch(id, mode, sessionFileId);
  if (!record) {
    throw new Error(`The task ${id} cannot move to queued. It sits in state ${deps.store.get(id)?.status ?? 'unknown'}.`);
  }
  const outcome = await deps.dispatch(id, mode, sessionFileId);
  return { text: `Task ${id} dispatched (${mode}). ${outcome}` };
}

/** Runs the list action. */
function runList(deps: TaskToolDeps, args: Record<string, unknown>): AgentToolOutput {
  const status = optionalString(args, 'status');
  const filter = (task: TaskRecord): boolean => !status || task.status === status;
  const known: TaskStatus[] = ['draft', 'queued', 'running', 'review', 'done', 'failed', 'cancelled'];
  if (status && !known.includes(status as TaskStatus)) {
    throw new Error(`The status "${status}" is none of ${known.join(', ')}.`);
  }
  const rows = deps.store.list().filter(filter).map(taskLine);
  return { text: rows.length > 0 ? rows.join('\n') : 'No task matches.' };
}

/** Runs the read action. */
function runRead(deps: TaskToolDeps, args: Record<string, unknown>): AgentToolOutput {
  return { text: taskDetail(recordOf(deps, requireId(args))) };
}

/** Runs the send action. The session chat and the origin chat may steer the task. */
async function runSend(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const message = requireString(args, 'message');
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
    throw new Error(`The chat of this turn may not steer task ${id}. Only its session and its origin chat may send into it.`);
  }
  return { text: await deps.send(id, message) };
}

/** Runs the complete action. Only the session agent completes its task. */
async function runComplete(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const result = requireString(args, 'result');
  const evidence = optionalString(args, 'evidence');
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId) {
    throw new Error(`Only the session that runs task ${id} may complete it. Wait for it with action wait instead.`);
  }
  const updated = await deps.store.complete(id, result, evidence);
  if (!updated) {
    throw new Error(`The task ${id} cannot move to review from state ${record.status}.`);
  }
  return { text: `Task ${id} waits for the user review.` };
}

/** Runs the fail action. Only the session agent fails its task. */
async function runFail(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const reason = optionalString(args, 'reason');
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId) {
    throw new Error(`Only the session that runs task ${id} may fail it.`);
  }
  const updated = await deps.store.fail(id, reason);
  if (!updated) {
    throw new Error(`The task ${id} cannot move to failed from state ${record.status}.`);
  }
  return { text: `Task ${id} failed. ${reason ?? ''}`.trim() };
}

/** Runs the wait action. The answer carries the settle or the timeout state. */
async function runWait(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const raw = args['timeoutMs'];
  const timeoutMs = typeof raw === 'number' && raw >= 1000 ? Math.min(Math.floor(raw), 600000) : 120000;
  const started = Date.now();
  for (;;) {
    const record = deps.store.get(id);
    if (!record) {
      throw new Error(`The task ${id} does not exist.`);
    }
    if (taskSettlesWaiter(record.status)) {
      return { text: `Task ${id} settled.\n${taskDetail(record)}` };
    }
    if (Date.now() - started >= timeoutMs) {
      return { text: `Task ${id} still holds state ${record.status} after ${Math.round(timeoutMs / 1000)} seconds.\n${taskLine(record)}` };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
}

/** Runs the cancel action. The session chat and the origin chat may cancel. */
async function runCancel(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const reason = optionalString(args, 'reason');
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
    throw new Error(`The chat of this turn may not cancel task ${id}. Only its session and its origin chat may stop it.`);
  }
  const updated = await deps.store.cancel(id, reason);
  if (!updated) {
    throw new Error(`The task ${id} cannot cancel from state ${record.status}.`);
  }
  return { text: `Task ${id} cancelled.` };
}

/** Builds the `tasks` tool: the naming surface and the dispatchable records in one. */
export function createTasksTool(deps: TaskToolDeps): AgentTool {
  return {
    name: 'tasks',
    description:
      'Manages the tasks of the workspace. Action name titles the work of this chat: it renames the tab, groups the patch events, and feeds the later commit title. The other actions serve the dispatchable task records: create starts a draft (title, description, goal, parentTaskId, blockedBy), dispatch binds one to a chat session, list and read inspect them, send steers a task session, complete and fail settle the work of the session agent (only the session agent), wait blocks until review or a terminal state, and cancel stops a task of this chat. A task leaves the queue only when every blockedBy task reached done.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['name', 'create', 'dispatch', 'list', 'read', 'send', 'complete', 'fail', 'wait', 'cancel'],
          description: 'The task action to run.',
        },
        title: { type: 'string', description: 'The task title. Actions name and create.' },
        description: { type: 'string', description: 'The task description: the later commit description on name, the brief on create.' },
        goal: { type: 'string', description: 'The completion test in prose. Verify it before complete. Action create only.' },
        parentTaskId: { type: 'string', description: 'The task this one was spawned from. Action create only.' },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must reach done before this task may run. Action create only.',
        },
        id: { type: 'string', description: 'The task id. Every action but name, create, and list.' },
        mode: { type: 'string', enum: ['new-session', 'session'], description: 'How the dispatch binds the session. Action dispatch only.' },
        sessionFileId: { type: 'string', description: 'The chat session file that takes the task. Session mode only.' },
        message: { type: 'string', description: 'The message into the task session. Action send only.' },
        amend: { type: 'boolean', description: 'True to change the open task of this chat. Action name only.' },
        result: { type: 'string', description: 'The completion summary. Action complete only.' },
        evidence: { type: 'string', description: 'The evidence of the goal test. Action complete only.' },
        reason: { type: 'string', description: 'The reason of a fail or a cancel.' },
        status: { type: 'string', description: 'The status filter. Action list only.' },
        timeoutMs: { type: 'integer', description: 'The wait cap in milliseconds, 1000 to 600000. Action wait only.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: async (args): Promise<AgentToolOutput> => {
      const action = args['action'];
      if (action === 'name') {
        return runName(deps, args);
      }
      if (action === 'create') {
        return runCreate(deps, args);
      }
      if (action === 'dispatch') {
        return runDispatch(deps, args);
      }
      if (action === 'read') {
        return runRead(deps, args);
      }
      if (action === 'send') {
        return runSend(deps, args);
      }
      if (action === 'complete') {
        return runComplete(deps, args);
      }
      if (action === 'fail') {
        return runFail(deps, args);
      }
      if (action === 'wait') {
        return runWait(deps, args);
      }
      if (action === 'cancel') {
        return runCancel(deps, args);
      }
      return runList(deps, args);
    },
  };
}
