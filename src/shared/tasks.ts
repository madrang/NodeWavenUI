/**
 * The shared contract of the dispatchable task records. A task names one unit of multi-part work:
 * agents and the user create tasks, the user or an allowed agent dispatches one onto a chat
 * session, and the session agent completes it for review. The type, the transition table, and the
 * read guard live here, so the renderer, the main process, and the MCP host read one shape.
 * Keep this file free of platform dependencies, so that every module can import it.
 */

/** The statuses of one task record, in life order. `blocked` means the session waits for the answer
 * of the operator to a question, `exhausted` means a token or turn budget ran out, and `timeout`
 * means the wall-clock cap passed. */
export const TASK_STATUSES = [
  'draft',
  'queued',
  'running',
  'blocked',
  'review',
  'done',
  'failed',
  'exhausted',
  'timeout',
  'cancelled',
] as const;

/** The status of one task record. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** What ends one record: the word of the session agent, a hand or a cancel, the provider after its
 * retries, a budget, the wall clock, the blocker it waited on, the close of its session tab, or a
 * session that could not start. */
export const TASK_END_CAUSES = [
  'agent',
  'user',
  'provider',
  'token-budget',
  'turn-budget',
  'timeout',
  'cascade',
  'session-closed',
  'session-start',
] as const;

/** Who or what ended one record. */
export type TaskEndCause = (typeof TASK_END_CAUSES)[number];

/** The priority of one record when its create names none. */
export const TASK_PRIORITY_DEFAULT = 5;

/** The highest priority of one record. The queue starts the higher priorities first. */
export const TASK_PRIORITY_MAX = 10;

/** Reads one priority: a whole number from zero to the maximum. A missing or damaged one reads as
 * the default. */
export function readTaskPriority(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ?
    Math.min(TASK_PRIORITY_MAX, Math.floor(value)) :
    TASK_PRIORITY_DEFAULT;
}

/** Orders two queued records for the queue: the higher priority first, and the earlier dispatch
 * wins a tie. */
export function compareQueueOrder(left: TaskRecord, right: TaskRecord): number {
  return right.priority - left.priority || (left.dispatchedAt ?? '').localeCompare(right.dispatchedAt ?? '');
}

/** How one dispatch binds a chat session. */
export type TaskDispatchMode = 'new-session' | 'session';

/** One connection of the fallback chain of a task: a provider account and one of its models. */
export interface TaskConnection {
  readonly providerId: string;
  readonly model: string;
}

/** The states of one step of the plan of a task, in work order. */
export const TASK_PLAN_STATES = ['pending', 'in_progress', 'completed'] as const;

/** The state of one step of the plan of a task. */
export type TaskPlanState = (typeof TASK_PLAN_STATES)[number];

/** One step of the plan of a task. The session agent writes the steps and moves them along. */
export interface TaskPlanStep {
  text: string;
  state: TaskPlanState;
}

/** The mark of each plan state, the way every surface and the task tool print a step. */
export const TASK_PLAN_MARKS: Readonly<Record<TaskPlanState, string>> = {
  pending: '☐',
  in_progress: '▶',
  completed: '✔',
};

/** Renders the plan of one record, one marked step per line. Empty without a plan. */
export function taskPlanLines(task: TaskRecord): string[] {
  return task.plan.map((step) => `${TASK_PLAN_MARKS[step.state]} ${step.text}`);
}

/** One reference that proves a goal: a patch the session proposed, or a command the session ran.
 * The engine verifies each one against the patch store and the transcript of the session before a
 * proof counts. */
export type TaskEvidence =
  { readonly kind: 'patch'; readonly id: number } |
  { readonly kind: 'command'; readonly command: string };

/** One goal of the checklist of a task: a verifiable end result. It stays open until a proof with
 * verified evidence meets it. */
export interface TaskGoal {
  text: string;
  met: boolean;
  evidence: readonly TaskEvidence[];
}

/** Renders one evidence reference, the way the tool and the cards name it. */
export function taskEvidenceLabel(evidence: TaskEvidence): string {
  return evidence.kind === 'patch' ? `patch ${evidence.id}` : `command: ${evidence.command}`;
}

/** The goals of one record that stay open. A complete refuses while one remains. */
export function taskOpenGoals(task: TaskRecord): readonly TaskGoal[] {
  return task.goals.filter((goal) => !goal.met);
}

/** Checks that a value is a list of strings. */
export function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** One task template: the brief a task starts from. The board fills its create form from one, and
 * the task tool copies one on a create. */
export interface TaskTemplate {
  /** The template id, a uuid string. It is also the file name. */
  readonly id: string;
  title: string;
  description: string;
  goal: string;
  goals: readonly string[];
  plan: readonly string[];
  /** The group the tasks of the template belong to. An empty string means none. */
  category: string;
  readonly createdAt: string;
}

/** The fields a task takes from a template. */
export interface TaskTemplateFields {
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly goals: readonly string[];
  readonly plan: readonly string[];
  readonly category: string;
}

/**
 * Reads one stored task template.
 *
 * @param value The value to check. It can have any type.
 * @returns The template, or null when one field carries a wrong type.
 */
export function readTaskTemplate(value: unknown): TaskTemplate | null {
  if (typeof value !== 'object' || !value) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' || candidate.id.length === 0 ||
    typeof candidate.title !== 'string' ||
    typeof candidate.createdAt !== 'string' || candidate.createdAt.length === 0 ||
    (candidate.description && typeof candidate.description !== 'string') ||
    (candidate.goal && typeof candidate.goal !== 'string') ||
    (candidate.goals && !isTextList(candidate.goals)) ||
    (candidate.plan && !isTextList(candidate.plan)) ||
    (candidate.category && typeof candidate.category !== 'string')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    title: candidate.title,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    goal: typeof candidate.goal === 'string' ? candidate.goal : '',
    goals: isTextList(candidate.goals) ? candidate.goals : [],
    plan: isTextList(candidate.plan) ? candidate.plan : [],
    category: typeof candidate.category === 'string' ? candidate.category : '',
    createdAt: candidate.createdAt,
  };
}

/** One dispatchable task record. */
export interface TaskRecord {
  /** The record id, a uuid string. It is also the file name. */
  readonly id: string;
  title: string;
  /** The brief the session agent reads. It carries the prompt. An empty string means none. */
  description: string;
  /** The completion test in prose. The agent verifies it before it completes the task. An empty
   * string means the task carries no goal. */
  goal: string;
  /** Who created the record: the user, or the agent of one chat. */
  readonly origin: 'user' | 'agent';
  /** The chat whose agent created the record, on agent origin. Null on user origin. */
  readonly originChatId: number | null;
  /** The task this record was spawned from, when an agent created it as a child. Null at the top. */
  readonly parentTaskId: string | null;
  /** The task ids that must reach done before this task may run. */
  readonly blockedBy: readonly string[];
  status: TaskStatus;
  /** How the dispatch binds the session. Null while the task was never dispatched. */
  dispatchMode: TaskDispatchMode | null;
  /** The persisted chat session file that runs or ran the task. Null until the dispatch binds one. */
  sessionFileId: string | null;
  /** The runtime chat id of the bound session, when one exists in this app run. Null otherwise. */
  sessionChatId: number | null;
  /** The completion summary of the agent, set on complete. */
  result: string | null;
  /** The evidence the agent names for its goal test, when it wrote one. */
  evidence: string | null;
  /** The comment of a failed or cancelled settle, when one was written. */
  note: string | null;
  /** The token cap of the whole task: prompt and completion tokens summed over its rounds. Null
   * means no cap. */
  maxTokens: number | null;
  /** The round cap of the whole task. Null means no cap. */
  maxTurns: number | null;
  /** The wall-clock cap of one running stretch, in milliseconds. Null means no cap. */
  timeoutMs: number | null;
  /** The prompt tokens the session of the task spent over its rounds. */
  tokensIn: number;
  /** The completion tokens the session of the task spent over its rounds. */
  tokensOut: number;
  /** The provider rounds the session of the task ran. */
  turns: number;
  /** When the current running stretch of the task started. Null before the first bind. */
  startedAt: string | null;
  /** Who or what ended the record. Null while it lives and on a review. */
  endCause: TaskEndCause | null;
  /** How many times the session retries a round its provider failed on the same connection, before
   * the fallback chain moves on. Null means the default of the engine. */
  retries: number | null;
  /** The connections the session tries in order when its own fails. An empty list means the other
   * accounts of the registry, each with its default model. */
  fallbacks: readonly TaskConnection[];
  /** The place of the record in the queue, from 0 to the maximum. The pump starts the higher
   * priorities first, and the earlier dispatch wins a tie. */
  priority: number;
  /** The plan of the task: the steps the session agent wrote, each with its state. */
  plan: readonly TaskPlanStep[];
  /** The checklist of the task: goals a proof with verified evidence meets. Empty means the word
   * of the agent alone completes the task. */
  goals: readonly TaskGoal[];
  /** The group the record belongs to. An empty string means none. A create from a template takes
   * the category of the template. */
  category: string;
  /** The open question of a blocked record: what the session asks the operator. Null otherwise. */
  question: string | null;
  /** When the record moved to blocked, so the wall-clock cap skips the wait for the answer. Null
   * while the record is not blocked. */
  blockedAt: string | null;
  readonly createdAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
}

/**
 * The allowed status transitions of one task record. A dispatch moves draft to queued, a session
 * takes a queued task to running, a question of the session moves it to blocked, the answer moves
 * it back to running, or to the queue when the workspace has no slot for it at once, the agent word moves running to review or failed, the budget and the wall clock
 * end a running task as exhausted or timeout, and the user review settles it: done, or back to
 * running on a return. A blocker that fails, or ends by a limit, takes its queued children to
 * failed, and one that cancels takes them to cancelled. The settled states answer no transition:
 * the user edit overrides the status by hand, and the agent reopen of one settled record sits
 * outside this table.
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'failed', 'cancelled'],
  running: ['review', 'blocked', 'failed', 'exhausted', 'timeout', 'cancelled'],
  blocked: ['running', 'queued', 'failed', 'cancelled'],
  review: ['done', 'running', 'cancelled'],
  done: [],
  failed: [],
  exhausted: [],
  timeout: [],
  cancelled: [],
};

/** Checks that one status transition is allowed. */
export function taskCanTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** True while a task still lives: its status can change again. A blocked task lives, because its
 * answer moves it on. */
export function taskIsLive(status: TaskStatus): boolean {
  return status === 'draft' || status === 'queued' || status === 'running' || status === 'blocked' || status === 'review';
}

/** True when a status answers a waiter: the review, a question of the session, or one of the
 * terminal states. */
export function taskSettlesWaiter(status: TaskStatus): boolean {
  return status === 'review' || status === 'blocked' || !taskIsLive(status);
}

/** The share of a token budget the wrap-up holds in reserve. */
const WRAPUP_TOKEN_SHARE = 0.1;

/** The token floor of the wrap-up reserve, because a round sends the whole transcript again. */
const WRAPUP_TOKEN_FLOOR = 20_000;

/** The smallest token cap a record takes: twice the reserve floor, so the task keeps as much room
 * to work as to wrap up. A smaller cap sits at the reserve from its first round, so the session
 * would wrap up before it works. The board and the task tool refuse one. A stored record keeps
 * the cap it holds. */
export const TASK_MIN_TOKEN_CAP = 2 * WRAPUP_TOKEN_FLOOR;

/** The rounds a turn budget holds in reserve for the wrap-up. */
const WRAPUP_TURN_RESERVE = 2;

/** The smallest round cap a record takes, for the same reason as the token cap: twice the reserve,
 * so the task keeps as many rounds to work as to wrap up. */
export const TASK_MIN_TURN_CAP = 2 * WRAPUP_TURN_RESERVE;

/** The budget state of one running record. `run` leaves its session free, `wrapup` holds the work
 * for a wrap-up, and `out` ends it. */
export type TaskBudgetState = 'run' | 'wrapup' | 'out';

/** Reads the budget state of one record against its caps. A null cap never binds. */
export function taskBudgetState(task: TaskRecord): TaskBudgetState {
  const tokens = task.maxTokens ?? Infinity;
  const turns = task.maxTurns ?? Infinity;
  const tokensLeft = tokens - task.tokensIn - task.tokensOut;
  const turnsLeft = turns - task.turns;
  if (tokensLeft <= 0 || turnsLeft <= 0) {
    return 'out';
  }
  // Without a token cap the first test never runs.
  const nearTokens = tokens !== Infinity && tokensLeft <= Math.max(tokens * WRAPUP_TOKEN_SHARE, WRAPUP_TOKEN_FLOOR);
  if (nearTokens || turnsLeft <= WRAPUP_TURN_RESERVE) {
    return 'wrapup';
  }
  return 'run';
}

/** The budget that ended one record: the tokens first, then the turns. Null while no budget ran out. */
export function taskBudgetCause(task: TaskRecord): TaskEndCause | null {
  if ((task.maxTokens ?? Infinity) <= task.tokensIn + task.tokensOut) {
    return 'token-budget';
  }
  if ((task.maxTurns ?? Infinity) <= task.turns) {
    return 'turn-budget';
  }
  return null;
}

/** The budget that holds a record for its wrap-up: the turns when their reserve ran low, else the
 * tokens when a token cap binds. Null when no cap binds. */
export function taskBudgetLimit(task: TaskRecord): TaskEndCause | null {
  if ((task.maxTurns ?? Infinity) - task.turns <= WRAPUP_TURN_RESERVE) {
    return 'turn-budget';
  }
  return task.maxTokens ? 'token-budget' : null;
}

/** Checks that a value is one task status. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

/** Checks that a value is one dispatch mode. */
function isTaskDispatchMode(value: unknown): value is TaskDispatchMode {
  return value === 'new-session' || value === 'session';
}

/** Checks that a value is one end cause. */
function isTaskEndCause(value: unknown): value is TaskEndCause {
  return TASK_END_CAUSES.includes(value as TaskEndCause);
}

/** Reads one stored cap: a whole number above zero, or null. */
function readCap(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Reads one stored spend count: a whole number from zero up. A missing or damaged count reads as zero. */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Reads one stored retry count: a whole number from zero up. A missing or damaged count reads as
 * null, which means the default of the engine. */
function readRetries(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Checks that a value is one evidence reference. */
function isTaskEvidence(value: unknown): value is TaskEvidence {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const { kind, id, command } = value as Record<string, unknown>;
  return (
    (kind === 'patch' && typeof id === 'number') ||
    (kind === 'command' && typeof command === 'string' && command.length > 0)
  );
}

/** Checks that a value is a checklist: goals that carry a text, a met flag, and evidence. */
function isTaskGoalList(value: unknown): value is TaskGoal[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const { text, met, evidence } = item as Record<string, unknown>;
      return (
        typeof text === 'string' &&
        (typeof met === 'boolean' || typeof met === 'undefined') &&
        (typeof evidence === 'undefined' || (Array.isArray(evidence) && evidence.every(isTaskEvidence)))
      );
    })
  );
}

/** Reads one stored goal. A goal that names no met flag stays open and holds no evidence. */
function readGoal(goal: TaskGoal): TaskGoal {
  return { text: goal.text, met: Boolean(goal.met), evidence: goal.evidence ?? [] };
}

/** Checks that a value is a plan: steps that carry a text and a known state. */
function isTaskPlan(value: unknown): value is TaskPlanStep[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const { text, state } = item as Record<string, unknown>;
      return typeof text === 'string' && TASK_PLAN_STATES.includes(state as TaskPlanState);
    })
  );
}

/** Checks that a value is a list of connections, each a provider id and a model. */
function isTaskConnectionList(value: unknown): value is TaskConnection[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>).providerId === 'string' &&
        typeof (item as Record<string, unknown>).model === 'string',
    )
  );
}

/** Checks that a value is a string array without holes. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Reads one stored task record.
 *
 * @param value The value to check. It can have any type.
 * @returns The record, or null when one field carries a wrong type.
 */
export function readTaskRecord(value: unknown): TaskRecord | null {
  if (typeof value !== 'object' || !value) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' || candidate.id.length === 0 ||
    typeof candidate.title !== 'string' ||
    (candidate.description && typeof candidate.description !== 'string') ||
    (candidate.goal && typeof candidate.goal !== 'string') ||
    (candidate.origin !== 'user' && candidate.origin !== 'agent') ||
    (candidate.originChatId && typeof candidate.originChatId !== 'number') ||
    (candidate.parentTaskId && typeof candidate.parentTaskId !== 'string') ||
    !isStringArray(candidate.blockedBy) || !isTaskStatus(candidate.status) ||
    (candidate.dispatchMode && !isTaskDispatchMode(candidate.dispatchMode)) ||
    (candidate.sessionFileId && typeof candidate.sessionFileId !== 'string') ||
    (candidate.sessionChatId && typeof candidate.sessionChatId !== 'number') ||
    (candidate.result && typeof candidate.result !== 'string') ||
    (candidate.evidence && typeof candidate.evidence !== 'string') ||
    (candidate.note && typeof candidate.note !== 'string') ||
    typeof candidate.createdAt !== 'string' || candidate.createdAt.length === 0 ||
    (candidate.dispatchedAt && typeof candidate.dispatchedAt !== 'string') ||
    (candidate.settledAt && typeof candidate.settledAt !== 'string') ||
    // The caps and the spend counts came after the first records. A missing one reads as no cap or as zero.
    (candidate.maxTokens && typeof candidate.maxTokens !== 'number') ||
    (candidate.maxTurns && typeof candidate.maxTurns !== 'number') ||
    (candidate.timeoutMs && typeof candidate.timeoutMs !== 'number') ||
    (candidate.tokensIn && typeof candidate.tokensIn !== 'number') ||
    (candidate.tokensOut && typeof candidate.tokensOut !== 'number') ||
    (candidate.turns && typeof candidate.turns !== 'number') ||
    (candidate.startedAt && typeof candidate.startedAt !== 'string') ||
    (candidate.fallbacks && !isTaskConnectionList(candidate.fallbacks)) ||
    (candidate.priority && typeof candidate.priority !== 'number') ||
    (candidate.plan && !isTaskPlan(candidate.plan)) ||
    (candidate.goals && !isTaskGoalList(candidate.goals)) ||
    (candidate.question && typeof candidate.question !== 'string') ||
    (candidate.blockedAt && typeof candidate.blockedAt !== 'string') ||
    (candidate.category && typeof candidate.category !== 'string')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    title: candidate.title,
    // Older records stored null for an absent brief or goal: they read as empty strings.
    description: typeof candidate.description === 'string' ? candidate.description : '',
    goal: typeof candidate.goal === 'string' ? candidate.goal : '',
    origin: candidate.origin,
    originChatId: typeof candidate.originChatId === 'number' ? candidate.originChatId : null,
    parentTaskId: typeof candidate.parentTaskId === 'string' ? candidate.parentTaskId : null,
    blockedBy: candidate.blockedBy,
    status: candidate.status,
    dispatchMode: isTaskDispatchMode(candidate.dispatchMode) ? candidate.dispatchMode : null,
    sessionFileId: typeof candidate.sessionFileId === 'string' ? candidate.sessionFileId : null,
    sessionChatId: typeof candidate.sessionChatId === 'number' ? candidate.sessionChatId : null,
    result: typeof candidate.result === 'string' ? candidate.result : null,
    evidence: typeof candidate.evidence === 'string' ? candidate.evidence : null,
    note: typeof candidate.note === 'string' ? candidate.note : null,
    maxTokens: readCap(candidate.maxTokens),
    maxTurns: readCap(candidate.maxTurns),
    timeoutMs: readCap(candidate.timeoutMs),
    tokensIn: readCount(candidate.tokensIn),
    tokensOut: readCount(candidate.tokensOut),
    turns: readCount(candidate.turns),
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : null,
    endCause: isTaskEndCause(candidate.endCause) ? candidate.endCause : null,
    retries: readRetries(candidate.retries),
    fallbacks: isTaskConnectionList(candidate.fallbacks) ? candidate.fallbacks : [],
    priority: readTaskPriority(candidate.priority),
    plan: isTaskPlan(candidate.plan) ? candidate.plan : [],
    goals: isTaskGoalList(candidate.goals) ? candidate.goals.map(readGoal) : [],
    category: typeof candidate.category === 'string' ? candidate.category : '',
    question: typeof candidate.question === 'string' ? candidate.question : null,
    blockedAt: typeof candidate.blockedAt === 'string' ? candidate.blockedAt : null,
    createdAt: candidate.createdAt,
    dispatchedAt: typeof candidate.dispatchedAt === 'string' ? candidate.dispatchedAt : null,
    settledAt: typeof candidate.settledAt === 'string' ? candidate.settledAt : null,
  };
}
