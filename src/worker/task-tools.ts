/**
 * The `tasks` tool of the chat agent: one surface over both task concepts, named in the plural
 * like `files`. The `name` action is the naming surface of the chat: it renames the tab, groups
 * the patch events, and feeds the later commit title. Every other action serves the dispatchable
 * task records. The completion signal lives here as an action, not in the end of a turn: the
 * session agent calls complete when its goal holds, and the task waits for the user review.
 */

import type { AgentTool, AgentToolOutput } from './agent-tools.js';
import {
  TASK_MIN_TOKEN_CAP,
  TASK_MIN_TURN_CAP,
  TASK_PLAN_STATES,
  TASK_PRIORITY_DEFAULT,
  TASK_PRIORITY_MAX,
  TASK_STATUSES,
  taskEvidenceLabel,
  taskOpenGoals,
  taskPlanLines,
  taskSettlesWaiter,
  type TaskConnection,
  type TaskDispatchMode,
  type TaskEvidence,
  type TaskPlanState,
  type TaskPlanStep,
  type TaskRecord,
  type TaskStatus,
  type TaskTemplate,
} from '../shared/tasks.js';
import type { TaskStore } from './task-store.js';
import type { TaskTemplateStore } from './task-templates.js';

/** The permission check shape the tool needs, kept local so the interface of agent-tools stays closed. */
export interface TaskToolCheck {
  check(principal: 'agent', action: string, target: { kind: 'tool'; name: string }, detail: string, source?: string | null): Promise<void>;
}

/** The verification of the evidence of a proof: the references that hold, and a reason for each one
 * that does not. */
export interface EvidenceVerification {
  readonly verified: readonly TaskEvidence[];
  readonly refused: readonly string[];
}

/** The dependencies the task tool needs. */
export interface TaskToolDeps {
  /** The task store of the workspace. */
  readonly store: TaskStore;
  /** The task templates of the workspace, for the templates action and the create action. */
  readonly templates: TaskTemplateStore;
  /** Opens or binds the chat session of one dispatch. Answers the outcome text for the agent. */
  readonly dispatch: (id: string, mode: TaskDispatchMode, sessionFileId: string | null) => Promise<string>;
  /** Returns one failed record and the children it failed to the queue, on the named session.
   * Answers the outcome text for the agent. */
  readonly retry: (id: string, mode: TaskDispatchMode, sessionFileId: string | null) => Promise<string>;
  /** Delivers one message into the task session. Answers the outcome text for the agent. */
  readonly send: (id: string, message: string) => Promise<string>;
  /** Names the work of the chat: the patch-group naming surface. Answers the outcome text. */
  readonly setTaskName: (title: string | null, description: string | null, amend: boolean) => Promise<string>;
  /** Verifies the evidence of a proof against what the session of the task did. */
  readonly verifyEvidence: (task: TaskRecord, evidence: readonly TaskEvidence[]) => EvidenceVerification;
  /** Reads the transcript of the session of one task. Null when the session holds no open tab. */
  readonly readEntries: (task: TaskRecord) => string | null;
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

/** The length of the short id the tool prints: the start of the uuid, which every action accepts. */
const SHORT_ID_LENGTH = 8;

/** The short form of one record id. */
function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
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

/** Reads one optional cap argument: a whole number above zero. Null when the argument is absent or
 * carries another shape, so a bad cap never binds. */
function optionalCap(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Reads one optional count argument: a whole number from zero up. Null when the argument is absent
 * or carries another shape. */
function optionalCount(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Reads one budget argument of the create action: a whole number at or above the smallest cap a
 * record takes. A smaller budget refuses the call, because the wrap-up reserve would hold the
 * session from its first round. Null when the argument is absent. */
function budgetCap(args: Record<string, unknown>, name: 'maxTokens' | 'maxTurns'): number | null {
  const cap = optionalCap(args, name);
  const smallest = name === 'maxTokens' ? TASK_MIN_TOKEN_CAP : TASK_MIN_TURN_CAP;
  if (cap && cap < smallest) {
    throw new Error(
      `The argument "${name}" needs ${smallest} or more: the wrap-up reserve of a task holds half of that, and a smaller budget wraps the session up before it works.`,
    );
  }
  return cap;
}

/** Reads one optional fallback list argument: the connections that name a provider and a model, in
 * order. An absent or malformed argument means no list of the record. */
function optionalConnections(args: Record<string, unknown>, name: string): TaskConnection[] {
  const value = args[name];
  if (!Array.isArray(value)) {
    return [];
  }
  const connections: TaskConnection[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const { providerId, model } = item as Record<string, unknown>;
    if (typeof providerId === 'string' && providerId && typeof model === 'string' && model) {
      connections.push({ providerId, model });
    }
  }
  return connections;
}

/** Reads the `steps` argument of the plan action: the step texts, or objects with a text and a
 * state. A step without a state starts pending. */
function readPlanSteps(args: Record<string, unknown>): TaskPlanStep[] {
  const value = args['steps'];
  if (!Array.isArray(value)) {
    throw new Error('The argument "steps" needs a list of step texts, or of objects with a text and a state.');
  }
  const steps: TaskPlanStep[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.length === 0) {
        throw new Error('Every step of the plan needs a text.');
      }
      steps.push({ text: item, state: 'pending' });
      continue;
    }
    const { text, state } = (!item || typeof item !== 'object' ? {} : item) as Record<string, unknown>;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Every step of the plan needs a text.');
    }
    steps.push({ text, state: TASK_PLAN_STATES.includes(state as TaskPlanState) ? (state as TaskPlanState) : 'pending' });
  }
  return steps;
}

/** Reads the proof of the prove action: the `proof` list, or the `evidence` argument of a call
 * that names no proof. A list that arrives as JSON text reads as the list, because a model sends
 * it that way. Each item names a patch id or a command. */
function readEvidence(args: Record<string, unknown>): TaskEvidence[] {
  let value: unknown = args['proof'] ?? args['evidence'];
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'The argument "proof" needs a list: objects with the kind "patch" and an id, or the kind "command" and a command.',
    );
  }
  const evidence: TaskEvidence[] = [];
  for (const item of value) {
    const { kind, id, command } = (!item || typeof item !== 'object' ? {} : item) as Record<string, unknown>;
    if (kind === 'patch' && typeof id === 'number') {
      evidence.push({ kind: 'patch', id });
    } else if (kind === 'command' && typeof command === 'string' && command) {
      evidence.push({ kind: 'command', command });
    } else {
      throw new Error('Every item of the proof names a patch id or a command.');
    }
  }
  return evidence;
}

/** Finds the place of the goal the prove action names: its number from 1, or its text. A number
 * that arrives as text, "1" for example, reads as the number. */
function goalIndexOf(record: TaskRecord, args: Record<string, unknown>): number {
  const target = args['goal'];
  const number =
    typeof target === 'number' ? target : typeof target === 'string' && /^\d+$/.test(target.trim()) ? Number(target) : 0;
  if (Number.isInteger(number) && number >= 1 && number <= record.goals.length) {
    return number - 1;
  }
  if (typeof target === 'string' && target) {
    const exact = record.goals.findIndex((goal) => goal.text === target);
    if (exact >= 0) {
      return exact;
    }
    const partial = record.goals.findIndex((goal) => goal.text.includes(target));
    if (partial >= 0) {
      return partial;
    }
  }
  throw new Error(
    `The argument "goal" needs the number of a goal of the task, from 1 to ${record.goals.length}, or its text.`,
  );
}

/** Renders one record as the one-line form the list action shows. */
function taskLine(task: TaskRecord): string {
  const blocked = task.blockedBy.length > 0 ? ` blockedBy ${task.blockedBy.map(shortId).join(',')}` : '';
  const session = task.sessionFileId ? ` session ${task.sessionFileId}` : '';
  const cause = task.endCause ? `: ${task.endCause}` : '';
  const priority = task.priority === TASK_PRIORITY_DEFAULT ? '' : ` prio ${task.priority}`;
  const goals =
    task.goals.length > 0 ? ` (${task.goals.filter((goal) => goal.met).length}/${task.goals.length} goals)` : '';
  return `${shortId(task.id)} [${task.status}${cause}]${task.goal ? ' (goal)' : ''}${goals}${priority}${blocked}${session} ${task.title}`;
}

/** Renders one record whole, for the read action and the settle answers of the wait. */
function taskDetail(task: TaskRecord): string {
  const rows = [
    `id: ${shortId(task.id)} (${task.id})`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `origin: ${task.origin}${task.originChatId ? ` chat ${task.originChatId}` : ''}`,
    `parent: ${task.parentTaskId ? shortId(task.parentTaskId) : 'none'}`,
    `blockedBy: ${task.blockedBy.length > 0 ? task.blockedBy.map(shortId).join(', ') : 'none'}`,
    `priority: ${task.priority}`,
    `session: ${task.sessionFileId ?? 'none'}`,
    `caps: ${task.maxTokens ? `${task.maxTokens} tokens` : 'no token cap'}, ${
      task.maxTurns ? `${task.maxTurns} rounds` : 'no round cap'
    }, ${task.timeoutMs ? `${Math.round(task.timeoutMs / 1000)} s` : 'no time limit'}`,
    `spend: ${task.tokensIn + task.tokensOut} tokens (${task.tokensIn} in, ${task.tokensOut} out), ${task.turns} ${
      task.turns === 1 ? 'round' : 'rounds'
    }${task.startedAt ? `, started ${task.startedAt}` : ''}`,
  ];
  if (task.endCause) {
    rows.push(`cause: ${task.endCause}`);
  }
  if (task.question) {
    rows.push(`question: ${task.question}`);
  }
  if (task.description) {
    rows.push(`description: ${task.description}`);
  }
  if (task.goal) {
    rows.push(`goal: ${task.goal}`);
  }
  if (task.plan.length > 0) {
    rows.push(`plan:\n${taskPlanLines(task).join('\n')}`);
  }
  if (task.goals.length > 0) {
    const goals = task.goals.map((goal, index) =>
      `  ${index + 1}. ${goal.met ? '✔' : '☐'} ${goal.text}${
        goal.evidence.length > 0 ? ` (${goal.evidence.map(taskEvidenceLabel).join(', ')})` : ''
      }`,
    );
    rows.push(`goals:\n${goals.join('\n')}`);
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

/** Reads the record of one id argument, or throws the miss: the full id, or the short start the
 * list action prints. */
function recordOf(deps: TaskToolDeps, id: string): TaskRecord {
  const record = deps.store.resolve(id);
  if (!record) {
    throw new Error(`The task ${id} matches no record, or its start matches several. Action list prints an id for each task.`);
  }
  return record;
}

/** Runs the name action: the patch-group naming surface of the chat. */
async function runName(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const amend = args['amend'] === true;
  return { text: await deps.setTaskName(optionalString(args, 'title'), optionalString(args, 'description'), amend) };
}

/** Reads the template of one create call: the id the call names, full or short. Null when the call
 * names no template. Throws when the name matches none. */
function templateOf(deps: TaskToolDeps, args: Record<string, unknown>): TaskTemplate | null {
  const name = optionalString(args, 'template');
  if (!name) {
    return null;
  }
  const template = deps.templates.resolve(name);
  if (!template) {
    throw new Error(`The template "${name}" matches no template. Action templates lists them with their ids.`);
  }
  return template;
}

/** Runs the create action. A template of the call fills the fields the call leaves out. */
async function runCreate(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  // An absent priority reads as the default, and a number above the maximum reads as the maximum.
  const priority = Math.min(TASK_PRIORITY_MAX, optionalCount(args, 'priority') ?? TASK_PRIORITY_DEFAULT);
  const template = templateOf(deps, args);
  const record = await deps.store.create({
    title: optionalString(args, 'title') ?? template?.title ?? (template ? '' : requireString(args, 'title')),
    description: optionalString(args, 'description') ?? template?.description ?? '',
    goal: optionalString(args, 'goal') ?? template?.goal ?? '',
    origin: 'agent',
    originChatId: deps.chatId,
    parentTaskId: optionalString(args, 'parentTaskId'),
    blockedBy: optionalStringList(args, 'blockedBy') ?? [],
    maxTokens: budgetCap(args, 'maxTokens'),
    maxTurns: budgetCap(args, 'maxTurns'),
    timeoutMs: optionalCap(args, 'timeLimitMs'),
    retries: optionalCount(args, 'retries'),
    fallbacks: optionalConnections(args, 'fallbacks'),
    priority,
    plan: optionalStringList(args, 'plan') ?? template?.plan ?? [],
    goals: optionalStringList(args, 'goals') ?? template?.goals ?? [],
    category: optionalString(args, 'category') ?? template?.category ?? '',
  });
  if (!record) {
    const parent = optionalString(args, 'parentTaskId');
    if (parent && !deps.store.resolve(parent)) {
      throw new Error(`The parent task ${parent} matches no record, or its start matches several.`);
    }
    const blocked = optionalStringList(args, 'blockedBy') ?? [];
    throw new Error(`The blockedBy list names a task that does not exist: ${blocked.join(', ')}.`);
  }
  return { text: `Task ${record.id} created as a draft: ${record.title}. The user dispatches it from the task board, or you dispatch it with action dispatch.` };
}

/** Runs the dispatch action. An allow rule on the tasks tool preauthorizes it. The record resolves
 * first, so a short id reaches the store and the engine under its full form. */
async function runDispatch(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const mode = args['mode'] === 'session' ? 'session' : 'new-session';
  const sessionFileId = mode === 'session' ? requireString(args, 'sessionFileId') : null;
  const record = recordOf(deps, id);
  if (!deps.dispatchAllowed()) {
    await deps.check.check('agent', 'tasks', { kind: 'tool', name: 'tasks' }, `dispatch task ${record.id} (${mode})`, deps.source);
  }
  const queued = await deps.store.dispatch(record.id, mode, sessionFileId);
  if (!queued) {
    throw new Error(`The task ${id} cannot move to queued. It sits in state ${record.status}.`);
  }
  const outcome = await deps.dispatch(record.id, mode, sessionFileId);
  return { text: `Task ${id} dispatched (${mode}). ${outcome}` };
}

/** Runs the templates action: lists the task templates of the workspace. */
function runTemplates(deps: TaskToolDeps): AgentToolOutput {
  const rows = deps.templates.list().map((template) =>
    `${shortId(template.id)}${template.category ? ` [${template.category}]` : ''} ${template.title}: ${
      template.description || template.goal || 'no brief'
    }`,
  );
  return {
    text:
      rows.length > 0 ?
        `Task templates. Action create with the template argument copies one:\n${rows.join('\n')}` :
        'No task template exists.',
  };
}

/** Runs the list action. The status and the parent narrow the rows. */
function runList(deps: TaskToolDeps, args: Record<string, unknown>): AgentToolOutput {
  const status = optionalString(args, 'status');
  const parent = optionalString(args, 'parentTaskId') ? recordOf(deps, requireString(args, 'parentTaskId')) : null;
  if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`The status "${status}" is none of ${TASK_STATUSES.join(', ')}.`);
  }
  const filter = (task: TaskRecord): boolean =>
    (!status || task.status === status) && (!parent || task.parentTaskId === parent.id);
  const rows = deps.store.list().filter(filter).map(taskLine);
  return { text: rows.length > 0 ? rows.join('\n') : 'No task matches.' };
}

/** Runs the plan action. Only the session agent writes the plan of its task. */
async function runPlan(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const steps = readPlanSteps(args);
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId) {
    throw new Error(`Only the session that runs task ${id} may write its plan.`);
  }
  const updated = await deps.store.setPlan(record.id, steps);
  if (!updated) {
    throw new Error(`The task ${id} is settled, so its plan no longer changes.`);
  }
  return { text: `The plan of task ${id} holds ${updated.plan.length} steps.` };
}

/** Runs the goals action: the checklist of the task is replaced. The session chat and the origin
 * chat may write it. */
async function runGoals(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
    throw new Error(`The chat of this turn may not set the goals of task ${id}. Only its session and its origin chat may.`);
  }
  const texts = optionalStringList(args, 'goals');
  if (!texts) {
    // An empty list clears the checklist. A missing argument must not read as one.
    throw new Error('The argument "goals" needs a list of goal texts. An empty list clears the checklist.');
  }
  const updated = await deps.store.setGoals(record.id, texts);
  if (!updated) {
    throw new Error(`The task ${id} is settled, so its checklist no longer changes.`);
  }
  return { text: `The checklist of task ${id} holds ${texts.length} goals.` };
}

/** Runs the prove action. Only the session agent meets a goal, and only with evidence the engine
 * verifies. */
async function runProve(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId) {
    throw new Error(`Only the session that runs task ${id} may prove its goals. Wait for it with action wait instead.`);
  }
  const index = goalIndexOf(record, args);
  const proof = deps.verifyEvidence(record, readEvidence(args));
  if (proof.refused.length > 0) {
    throw new Error(
      `The proof refused its items: ${proof.refused.join('; ')}. Name a patch this session proposed, or a command this session ran.`,
    );
  }
  const updated = await deps.store.proveGoal(record.id, index, proof.verified);
  if (!updated) {
    throw new Error(`The task ${id} does not run, so its goals take no proof.`);
  }
  const open = taskOpenGoals(updated).length;
  const met = `Goal ${index + 1} of task ${id} is met.`;
  return {
    text: open === 0 ? `${met} Every goal is met, so action complete may follow.` : `${met} ${open} goals stay open.`,
  };
}

/** Runs the read action. The record is the answer, or the transcript of its session when the caller
 * asks for the entries. The session chat and the origin chat may read the transcript. */
function runRead(deps: TaskToolDeps, args: Record<string, unknown>): AgentToolOutput {
  const record = recordOf(deps, requireId(args));
  if (args['part'] === 'entries') {
    if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
      throw new Error(`The chat of this turn may not read the session of task ${record.id}. Only its session and its origin chat may.`);
    }
    const transcript = deps.readEntries(record);
    if (!transcript) {
      throw new Error(`The task ${record.id} holds no open session tab in this app run.`);
    }
    return { text: transcript };
  }
  return { text: taskDetail(record) };
}

/** Runs the send action. The session chat and the origin chat may steer the task. */
async function runSend(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const message = requireString(args, 'message');
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
    throw new Error(`The chat of this turn may not steer task ${id}. Only its session and its origin chat may send into it.`);
  }
  return { text: await deps.send(record.id, message) };
}

/** Runs the ask action. Only the session agent asks, and only while its task runs: the question
 * puts the record in blocked until the operator answers. */
async function runAsk(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const question = requireString(args, 'question');
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId) {
    throw new Error(`Only the session that runs task ${id} may ask its operator. Wait for it with action wait instead.`);
  }
  const updated = await deps.store.block(record.id, question);
  if (!updated) {
    throw new Error(`The task ${id} cannot move to blocked from state ${record.status}.`);
  }
  return {
    text:
      `The question went to the operator, and task ${id} now waits (blocked). End your turn here. ` +
      'The answer arrives as the next message of this session, and the task runs on.',
  };
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
  // A checklist holds the completion back until a proof met every goal.
  const open = taskOpenGoals(record);
  if (open.length > 0) {
    throw new Error(
      `The task ${id} keeps ${open.length} open goals: ${open.map((goal) => goal.text).join('; ')}. Prove each one with action prove (id, goal, proof) first, or fail the task.`,
    );
  }
  const updated = await deps.store.complete(record.id, result, evidence);
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
  const updated = await deps.store.fail(record.id, reason, 'agent');
  if (!updated) {
    throw new Error(`The task ${id} cannot move to failed from state ${record.status}.`);
  }
  return { text: `Task ${id} failed. ${reason ?? ''}`.trim() };
}

/** Runs the wait action. The store wakes it on every record change, so a settle answers at once.
 * The answer carries the settle or the timeout state. */
async function runWait(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const raw = args['timeoutMs'];
  const timeoutMs = typeof raw === 'number' && raw >= 1000 ? Math.min(Math.floor(raw), 600000) : 120000;
  const started = Date.now();
  // One resolver per sleep: a record change ends the sleep, and the loop reads the record again.
  let wake: (() => void) | null = null;
  const unsubscribe = deps.store.subscribe(() => {
    if (wake) {
      wake();
    }
  });
  try {
    for (;;) {
      const record = deps.store.resolve(id);
      if (!record) {
        throw new Error(`The task ${id} does not exist.`);
      }
      // A question of the session answers the wait of the caller too: the operator may be the caller.
      if (record.status === 'blocked') {
        return {
          text: `Task ${id} waits on the answer of the operator: ${record.question}\nThe task runs on once the operator answers. Call wait again to learn the outcome.`,
        };
      }
      if (taskSettlesWaiter(record.status)) {
        return { text: `Task ${id} settled.\n${taskDetail(record)}` };
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        return {
          text: `Task ${id} still holds state ${record.status} after ${Math.round(timeoutMs / 1000)} seconds.\n${taskLine(record)}`,
        };
      }
      // The resolver arms before this step yields, so a settle that lands between the read and the
      // sleep still wakes it.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    unsubscribe();
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
  const updated = await deps.store.cancel(record.id, reason, 'agent');
  if (!updated) {
    throw new Error(`The task ${id} cannot cancel from state ${record.status}.`);
  }
  return { text: `Task ${id} cancelled.` };
}

/** Runs the reopen action: one settled task returns to draft for a new dispatch. The permission
 * gate asks one card, unless an allow rule preauthorizes the tasks tool, and the session chat and
 * the origin chat may ask it. */
async function runReopen(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
    throw new Error(`The chat of this turn may not reopen task ${id}. Only its session and its origin chat may resubmit it.`);
  }
  if (!deps.dispatchAllowed()) {
    await deps.check.check('agent', 'tasks', { kind: 'tool', name: 'tasks' }, `reopen task ${id} (${record.status}) as a draft`, deps.source);
  }
  const updated = await deps.store.reopen(record.id);
  if (!updated) {
    throw new Error(`The task ${id} cannot reopen from state ${record.status}. Only a settled task reopens.`);
  }
  return { text: `Task ${id} reopened as a draft: ${record.title}. The user dispatches it again from the task board.` };
}

/** Runs the retry action: one failed record of this chat returns to the queue on the session the
 * call names, and the children it failed return with it. The permission gate asks one card, unless
 * an allow rule preauthorizes the tasks tool. */
async function runRetry(deps: TaskToolDeps, args: Record<string, unknown>): Promise<AgentToolOutput> {
  const id = requireId(args);
  const record = recordOf(deps, id);
  if (record.sessionChatId !== deps.chatId && record.originChatId !== deps.chatId) {
    throw new Error(`The chat of this turn may not retry task ${id}. Only its session and its origin chat may retry it.`);
  }
  const mode = args['mode'] === 'session' ? 'session' : 'new-session';
  const sessionFileId = mode === 'session' ? requireString(args, 'sessionFileId') : null;
  if (!deps.dispatchAllowed()) {
    await deps.check.check('agent', 'tasks', { kind: 'tool', name: 'tasks' }, `retry task ${id} (${mode})`, deps.source);
  }
  return { text: await deps.retry(record.id, mode, sessionFileId) };
}

/** Builds the `tasks` tool: the naming surface and the dispatchable records in one. */
export function createTasksTool(deps: TaskToolDeps): AgentTool {
  return {
    name: 'tasks',
    description:
      'Manages the tasks of the workspace. Action name titles the work of this chat: it renames the tab, groups the patch events, and feeds the commit title. The other actions serve the dispatchable task records: create starts a draft (title, description, goal, parentTaskId, blockedBy, the caps maxTokens, maxTurns, timeLimitMs, and the plan), dispatch binds one to a chat session, list and read inspect them (list narrows by status or parentTaskId, and read answers the record or the transcript of the session), send steers a task session, plan replaces the steps of the plan of the task the session runs (only the session agent), goals replaces the checklist of a task (its session or its origin chat), prove meets one goal of the checklist with a proof list that the engine verifies (only the session agent), ask puts a question to the operator and blocks the task until the answer arrives (only the session agent), templates lists the task templates of the workspace, complete and fail settle the work of the session agent (only the session agent), wait blocks until review or a terminal state, cancel stops a task of this chat, and reopen returns one settled task of this chat to a draft that the user approves and dispatches again. retry returns one failed task of this chat and the children it failed to the queue, on a new session or on the session the call names. A task leaves the queue only when every blockedBy task reached done. A budget that runs low or a time limit that passes wraps the session up: it keeps the write-back tools only, and the task then ends as exhausted or timeout unless the agent settles it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'name',
            'create',
            'dispatch',
            'list',
            'read',
            'send',
            'plan',
            'goals',
            'prove',
            'ask',
            'templates',
            'complete',
            'fail',
            'wait',
            'cancel',
            'reopen',
            'retry',
          ],
          description: 'The task action to run.',
        },
        title: { type: 'string', description: 'The task title. Actions name and create.' },
        description: { type: 'string', description: 'The task description: the later commit description on name, the brief on create.' },
        goal: {
          type: ['string', 'integer'],
          description:
            'The completion test in prose on create. On prove, the goal to meet: its number from 1, or its text. Actions create and prove.',
        },
        goals: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The checklist of the task: one goal per item. Each goal stays open until the session proves it, and complete refuses while one is open. Actions create and goals.',
        },
        evidence: {
          type: 'string',
          description: 'The evidence of the goal test, as text. Action complete only.',
        },
        proof: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['patch', 'command'] },
              id: { type: 'integer' },
              command: { type: 'string' },
            },
            required: ['kind'],
          },
          description:
            'The proof of a goal, as a list. Each item names a patch this session proposed (kind patch, id), or a command this session ran (kind command, command). The engine verifies each item. Action prove only.',
        },
        parentTaskId: {
          type: 'string',
          description: 'The task this one was spawned from on create. On list, the parent whose children the rows name.',
        },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must reach done before this task may run. Action create only.',
        },
        maxTokens: {
          type: 'integer',
          description: `The token cap of the whole task: prompt and completion tokens summed over its rounds. Absent means no cap. The smallest cap is ${TASK_MIN_TOKEN_CAP}. Action create only.`,
        },
        maxTurns: {
          type: 'integer',
          description: `The round cap of the whole task. Absent means no cap. The smallest cap is ${TASK_MIN_TURN_CAP}. Action create only.`,
        },
        timeLimitMs: {
          type: 'integer',
          description: 'The wall-clock cap of one running stretch, in milliseconds. Absent means no cap. Action create only.',
        },
        retries: {
          type: 'integer',
          description:
            'How many times the session retries a round its provider failed on the same connection. Absent means two. Action create only.',
        },
        fallbacks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { providerId: { type: 'string' }, model: { type: 'string' } },
            required: ['providerId', 'model'],
          },
          description:
            'The connections the session tries in order when its own fails. Absent means the other accounts of the registry. Action create only.',
        },
        priority: {
          type: 'integer',
          description: 'The place of the task in the queue, from 0 to 10. The queue starts the higher numbers first. Absent means 5. Action create only.',
        },
        plan: {
          type: 'array',
          items: { type: 'string' },
          description: 'The steps of the plan of the task, in order. Each starts pending. Action create only.',
        },
        steps: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  state: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['text'],
              },
            ],
          },
          description:
            'The plan of the task, in order: the step texts, or objects with a text and a state. The list replaces the stored plan. Action plan only.',
        },
        id: {
          type: 'string',
          description: 'The task id, full or the short start that action list prints. Every action but name, create, and list.',
        },
        part: {
          type: 'string',
          enum: ['record', 'entries'],
          description:
            'What read answers: the record (the default), or the transcript of the session of the task. Action read only.',
        },
        question: {
          type: 'string',
          description:
            'The question of the session for the operator. The task waits (blocked) until the operator answers. Action ask only.',
        },
        template: {
          type: 'string',
          description:
            'The id of a task template to copy: its title, its brief, its goal, its checklist, its plan, and its category. An argument of the create overrides the field of the template. Action create only.',
        },
        category: {
          type: 'string',
          description: 'The group of the task, the name of a category. An empty string means none. Action create only.',
        },
        mode: { type: 'string', enum: ['new-session', 'session'], description: 'How the dispatch or the retry binds the session. Actions dispatch and retry.' },
        sessionFileId: { type: 'string', description: 'The chat session file that takes the task. Session mode only.' },
        message: { type: 'string', description: 'The message into the task session. Action send only.' },
        amend: { type: 'boolean', description: 'True to change the open task of this chat. Action name only.' },
        result: { type: 'string', description: 'The completion summary. Action complete only.' },
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
      if (action === 'plan') {
        return runPlan(deps, args);
      }
      if (action === 'goals') {
        return runGoals(deps, args);
      }
      if (action === 'prove') {
        return runProve(deps, args);
      }
      if (action === 'ask') {
        return runAsk(deps, args);
      }
      if (action === 'templates') {
        return runTemplates(deps);
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
      if (action === 'reopen') {
        return runReopen(deps, args);
      }
      if (action === 'retry') {
        return runRetry(deps, args);
      }
      return runList(deps, args);
    },
  };
}
