/**
 * The shared contract of the dispatchable task records. A task names one unit of multi-part work:
 * agents and the user create tasks, the user or an allowed agent dispatches one onto a chat
 * session, and the session agent completes it for review. The type, the transition table, and the
 * read guard live here, so the renderer, the main process, and the MCP host read one shape.
 * Keep this file free of platform dependencies, so that every module can import it.
 */

/** The statuses of one task record. */
export type TaskStatus = 'draft' | 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled';

/** How one dispatch binds a chat session. */
export type TaskDispatchMode = 'new-session' | 'session';

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
  readonly createdAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
}

/**
 * The allowed status transitions of one task record. A dispatch moves draft to queued, a session
 * takes a queued task to running, the agent word moves running to review or failed, and the user
 * review settles it: done, or back to running on a return.
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['review', 'failed', 'cancelled'],
  review: ['done', 'running', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

/** Checks that one status transition is allowed. */
export function taskCanTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** True while a task still lives: its status can change again. */
export function taskIsLive(status: TaskStatus): boolean {
  return status !== 'done' && status !== 'failed' && status !== 'cancelled';
}

/** True when a status answers a waiter: the review, or one of the terminal states. */
export function taskSettlesWaiter(status: TaskStatus): boolean {
  return status === 'review' || !taskIsLive(status);
}

/** Checks that a value is one task status. */
function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === 'draft' || value === 'queued' || value === 'running' ||
    value === 'review' || value === 'done' || value === 'failed' || value === 'cancelled'
  );
}

/** Checks that a value is one dispatch mode. */
function isTaskDispatchMode(value: unknown): value is TaskDispatchMode {
  return value === 'new-session' || value === 'session';
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
    (candidate.settledAt && typeof candidate.settledAt !== 'string')
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
    createdAt: candidate.createdAt,
    dispatchedAt: typeof candidate.dispatchedAt === 'string' ? candidate.dispatchedAt : null,
    settledAt: typeof candidate.settledAt === 'string' ? candidate.settledAt : null,
  };
}
