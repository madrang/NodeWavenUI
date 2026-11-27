/**
 * The store of the dispatchable task records, owned by the worker core. One JSON file per task
 * lives in the workspace `tasks/` folder, plain like the patch records, so a restart loses
 * nothing. The store owns the transition rules of `src/shared/tasks.ts`: every mutator refuses a
 * move the table forbids and answers null, so a caller never guesses the outcome. The renderers
 * reach the store through the core contract.
 */

import type { CoreTaskUpdateInput } from '../shared/core-api.js';
import {
  compareQueueOrder,
  readTaskPriority,
  readTaskRecord,
  taskCanTransition,
  taskIsLive,
  taskOpenGoals,
  taskSettlesWaiter,
  type TaskConnection,
  type TaskDispatchMode,
  type TaskEndCause,
  type TaskEvidence,
  type TaskPlanStep,
  type TaskRecord,
} from '../shared/tasks.js';
import {
  renamePath,
  joinPath,
  listDirectoryNames,
  makeDirectory,
  readTextFile,
  removePath,
  writeTextFile,
} from './node-file-system.js';

/** The input of one create call. An absent cap means none. */
export interface TaskCreateInput {
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly origin: 'user' | 'agent';
  readonly originChatId: number | null;
  readonly parentTaskId: string | null;
  readonly blockedBy: readonly string[];
  readonly maxTokens?: number | null;
  readonly maxTurns?: number | null;
  readonly timeoutMs?: number | null;
  /** How many times the session retries a failed round on the same connection. Null means the default of the engine. */
  readonly retries?: number | null;
  /** The connections the session tries in order when its own fails. Absent means the other accounts of the registry. */
  readonly fallbacks?: readonly TaskConnection[];
  /** The place of the record in the queue. Absent means the default priority. */
  readonly priority?: number;
  /** The steps of the plan of the record, in order. Each starts pending. */
  readonly plan?: readonly string[];
  /** The checklist of the record. Each goal starts open. */
  readonly goals?: readonly string[];
  /** The group of the record. An empty string means none. */
  readonly category?: string;
}

/** The editable fields of one record, the shape of the core contract. An absent field keeps its
 * stored value, and an empty string clears it. The status is the hand override of the user edit:
 * it accepts every status, outside the transition table. An absent cap keeps its stored value, and
 * null clears it. */
export type TaskUpdateInput = CoreTaskUpdateInput;

/** Owns the task records of the workspace. */
export class TaskStore {
  private readonly root: string;
  /** The workspace `archive/` folder: the settled records the user put away live there. */
  private readonly archiveRoot: string;
  private readonly records = new Map<string, TaskRecord>();
  private readonly archivedRecords = new Map<string, TaskRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly settleListeners = new Set<(task: TaskRecord) => void>();

  /**
   * @param workspacePath The absolute path of the workspace directory, the parent of `tasks/`.
   */
  constructor(workspacePath: string) {
    this.root = joinPath(workspacePath, 'tasks');
    this.archiveRoot = joinPath(workspacePath, 'archive');
  }

  /** Reads every stored record into memory, and every archived record. Call once at boot, before
   * any tool runs. The archive folder appears with the first archive, so its absence reads as no
   * archived record. */
  async load(): Promise<void> {
    await makeDirectory(this.root);
    await this.readFolder(this.root, this.records);
    await this.readFolder(this.archiveRoot, this.archivedRecords);
  }

  /** Reads the record files of one folder into one map. A folder that is not there reads as empty,
   * and a damaged file drops out. */
  private async readFolder(root: string, into: Map<string, TaskRecord>): Promise<void> {
    const names = await listDirectoryNames(root);
    if (!names) {
      return;
    }
    for (const name of names) {
      if (!name.startsWith('task-') || !name.endsWith('.json')) {
        continue;
      }
      const text = await readTextFile(joinPath(root, name));
      // eslint-disable-next-line local/prefer-truthiness -- an empty record file reads as an empty string, only a failed read skips
      if (text === null) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      const record = readTaskRecord(value);
      if (record && record.id === name.slice('task-'.length, -'.json'.length)) {
        into.set(record.id, record);
      }
    }
  }

  /** Subscribes to every record change. The listener holds no arguments: it re-reads the lists. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribes to the settles: one listener call per record that reaches review or a terminal state. */
  onSettle(listener: (task: TaskRecord) => void): () => void {
    this.settleListeners.add(listener);
    return () => {
      this.settleListeners.delete(listener);
    };
  }

  /** Fires every record listener. */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Fires every settle listener with one record that reached review or a terminal state. */
  private notifySettled(record: TaskRecord): void {
    for (const listener of this.settleListeners) {
      listener(record);
    }
  }

  /** Clears the settle fields of one record, so the record returns to its live, editable state. */
  private clearSettle(record: TaskRecord): void {
    record.result = null;
    record.evidence = null;
    record.note = null;
    record.settledAt = null;
    record.endCause = null;
  }

  /** Clears the run fields of one record, so a new dispatch starts with a full budget, a fresh
   * clock, and an open checklist. */
  private clearRun(record: TaskRecord): void {
    record.tokensIn = 0;
    record.tokensOut = 0;
    record.turns = 0;
    record.startedAt = null;
    record.question = null;
    record.blockedAt = null;
    record.goals = record.goals.map((goal) => ({ text: goal.text, met: false, evidence: [] }));
  }

  /** Replaces the checklist of one record with the given texts. A goal whose text stays the same at
   * the same place keeps its proof, and every other goal starts open. */
  private replaceGoals(record: TaskRecord, texts: readonly string[]): void {
    record.goals = texts.map((text, index) => {
      const kept = record.goals[index];
      return kept?.met && kept.text === text ? kept : { text, met: false, evidence: [] };
    });
  }

  /** Reads every record, newest first. The archived records stay out. */
  list(): readonly TaskRecord[] {
    return [...this.records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Reads the archived records, newest first. */
  archived(): readonly TaskRecord[] {
    return [...this.archivedRecords.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Reads one record. */
  get(id: string): TaskRecord | null {
    return this.records.get(id) ?? null;
  }

  /** Reads one record by its id, or by the start of its id that the task tool prints. Null when no
   * record matches, or when the start matches several: the full id then names one. */
  resolve(id: string): TaskRecord | null {
    const exact = this.records.get(id);
    if (exact) {
      return exact;
    }
    const matches = [...this.records.values()].filter((record) => record.id.startsWith(id));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  /** True when every blockedBy task of one record reached done. A missing reference blocks. */
  ready(record: TaskRecord): boolean {
    return record.blockedBy.every((id) => this.records.get(id)?.status === 'done');
  }

  /**
   * Creates one record. The parent and every blockedBy id must name a known record, by its id or
   * by the start of it, so a typo cannot block a task forever. The record keeps the full ids.
   *
   * @param input The record facts.
   * @returns The record, or null when the parent or one blockedBy id names no record.
   */
  async create(input: TaskCreateInput): Promise<TaskRecord | null> {
    const parent = input.parentTaskId ? this.resolve(input.parentTaskId) : null;
    if (input.parentTaskId && !parent) {
      return null;
    }
    const blockedBy: string[] = [];
    for (const id of input.blockedBy) {
      const blocker = this.resolve(id);
      if (!blocker) {
        return null;
      }
      blockedBy.push(blocker.id);
    }
    const record: TaskRecord = {
      id: crypto.randomUUID(),
      title: input.title,
      description: input.description,
      goal: input.goal,
      origin: input.origin,
      originChatId: input.originChatId,
      parentTaskId: parent?.id ?? null,
      blockedBy,
      status: 'draft',
      dispatchMode: null,
      sessionFileId: null,
      sessionChatId: null,
      result: null,
      evidence: null,
      note: null,
      maxTokens: input.maxTokens ?? null,
      maxTurns: input.maxTurns ?? null,
      timeoutMs: input.timeoutMs ?? null,
      tokensIn: 0,
      tokensOut: 0,
      turns: 0,
      startedAt: null,
      endCause: null,
      retries: input.retries ?? null,
      fallbacks: [...(input.fallbacks ?? [])],
      priority: readTaskPriority(input.priority),
      plan: [...(input.plan ?? [])].map((text) => ({ text, state: 'pending' as const })),
      goals: [...(input.goals ?? [])].map((text) => ({ text, met: false, evidence: [] })),
      category: input.category ?? '',
      question: null,
      blockedAt: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      settledAt: null,
    };
    this.records.set(record.id, record);
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Dispatches one record: draft moves to queued. A session-mode dispatch names the chat session
   * file that will take the task. The queue claim checks the blockedBy state again, so a dispatch
   * on a blocked task simply waits.
   *
   * @param id The record id.
   * @param mode How the dispatch binds the session.
   * @param sessionFileId The chat session file, on session mode. Null on new-session mode.
   * @returns The record, or null when the transition is forbidden.
   */
  async dispatch(id: string, mode: TaskDispatchMode, sessionFileId: string | null): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'queued')) {
      return null;
    }
    record.status = 'queued';
    record.dispatchMode = mode;
    record.sessionFileId = mode === 'session' ? sessionFileId : null;
    record.sessionChatId = null;
    record.dispatchedAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    return record;
  }

  /** Reads the queued records in queue order: the higher priority first, then the earlier dispatch. */
  queued(): readonly TaskRecord[] {
    return this.list().filter((record) => record.status === 'queued').sort(compareQueueOrder);
  }

  /**
   * Reads the next queued task of one chat session, when one is ready. The queue order is the
   * priority, then the dispatch order.
   *
   * @param sessionFileId The chat session file.
   * @returns The record, or null when no ready task waits for the session.
   */
  nextQueuedFor(sessionFileId: string): TaskRecord | null {
    const queued = this.queued().filter((record) => record.dispatchMode === 'session' && record.sessionFileId === sessionFileId);
    return queued.find((record) => this.ready(record)) ?? null;
  }

  /**
   * Binds one record to the chat that runs it and moves it to running. A queued new-session task
   * binds the chat the dispatch opened; a queued session task binds the chat that took it from
   * the queue.
   *
   * @param id The record id.
   * @param chatId The runtime chat id of the session.
   * @param sessionFileId The persisted chat session file.
   * @returns The record, or null when the transition is forbidden.
   */
  async bindSession(id: string, chatId: number, sessionFileId: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'running')) {
      return null;
    }
    record.status = 'running';
    record.sessionChatId = chatId;
    record.sessionFileId = sessionFileId;
    // The clock of the wall-clock cap starts when the session takes the task.
    record.startedAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Completes one record: running moves to review, and the summary with its evidence waits for the
   * user. A checklist goal that stays open holds the completion back: the proof of each goal comes
   * first.
   *
   * @param id The record id.
   * @param result The completion summary.
   * @param evidence The evidence of the goal test, when one was written.
   * @returns The record, or null when the transition is forbidden or a goal stays open.
   */
  async complete(id: string, result: string, evidence: string | null): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'review') || taskOpenGoals(record).length > 0) {
      return null;
    }
    record.status = 'review';
    record.result = result;
    record.evidence = evidence;
    await this.write(record);
    this.emit();
    this.notifySettled(record);
    return record;
  }

  /**
   * Fails one record: running moves to failed, and the queued children that wait on it fail with
   * it.
   *
   * @param id The record id.
   * @param note The reason, when one was written.
   * @param cause Who or what failed the record: the agent by default, the provider after its retries.
   * @returns The record, or null when the transition is forbidden.
   */
  async fail(id: string, note: string | null, cause: TaskEndCause = 'agent'): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'failed')) {
      return null;
    }
    record.status = 'failed';
    record.note = note;
    record.endCause = cause;
    record.question = null;
    record.blockedAt = null;
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.notifySettled(record);
    await this.settleWaitingChildren(record.id, 'failed', 'failed');
    return record;
  }

  /**
   * Cancels one record from any live state.
   *
   * @param id The record id.
   * @param note The reason, when one was written.
   * @param cause Who or what cancelled the record: a hand by default.
   * @returns The record, or null when the record is absent or already settled.
   */
  async cancel(id: string, note: string | null, cause: TaskEndCause = 'user'): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskIsLive(record.status) || !taskCanTransition(record.status, 'cancelled')) {
      return null;
    }
    record.status = 'cancelled';
    record.note = note;
    record.endCause = cause;
    record.question = null;
    record.blockedAt = null;
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.notifySettled(record);
    await this.settleWaitingChildren(record.id, 'cancelled', 'was cancelled');
    return record;
  }

  /**
   * Settles the queued records that wait on one record. A blocker that failed, was cancelled, or
   * left the store never reaches done, so each queued child settles the way its blocker did, with
   * a note that names the blocker, and the settle reaches the settle listeners like any other:
   * the origin chat of the child learns it. A blocker that failed, or ended by a limit, fails its
   * children with the cause `cascade`, and each failed child fails its own queued children in
   * turn. A cancelled or removed blocker cancels its children. A draft child keeps its draft,
   * because its blocker may come back through a reopen.
   *
   * @param blockerId The record the children wait on.
   * @param status The settle of the blocker for its children: failed, or cancelled.
   * @param cause The end of the blocker, for the note of each child.
   */
  private async settleWaitingChildren(blockerId: string, status: 'failed' | 'cancelled', cause: string): Promise<void> {
    for (const child of this.list()) {
      if (child.status === 'queued' && child.blockedBy.includes(blockerId)) {
        const note = `The blocker task ${blockerId} ${cause}.`;
        if (status === 'failed') {
          await this.fail(child.id, note, 'cascade');
        } else {
          await this.cancel(child.id, note, 'cascade');
        }
      }
    }
  }

  /**
   * Accepts one review: review moves to done, and the tasks it blocks may run.
   *
   * @param id The record id.
   * @returns The record, or null when the transition is forbidden.
   */
  async accept(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'done')) {
      return null;
    }
    record.status = 'done';
    record.endCause = 'user';
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.notifySettled(record);
    return record;
  }

  /**
   * Reopens one settled record: it moves back to draft. The agent reopen action runs this path.
   * The user edit holds the wider hand override through `update`. The settle fields and the run
   * fields clear, so the record returns to its editable, dispatchable state with a full budget.
   *
   * @param id The record id.
   * @returns The record, or null when the record is absent or still lives.
   */
  async reopen(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || taskIsLive(record.status)) {
      return null;
    }
    record.status = 'draft';
    this.clearSettle(record);
    this.clearRun(record);
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Returns one review to the session: review moves back to running, and the comment of the user
   * rides to the agent as a re-brief. The old result and evidence clear, so the next completion
   * writes a fresh summary. The return starts a new running stretch, so the wall-clock cap starts
   * again, while the spend of the task carries on.
   *
   * @param id The record id.
   * @returns The record, or null when the transition is forbidden.
   */
  async returnToSession(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'running')) {
      return null;
    }
    record.status = 'running';
    this.clearSettle(record);
    record.startedAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Replaces the plan of one record: the steps the session agent wrote, each with its state. Every
   * live state accepts the plan, and an empty list clears it.
   *
   * @param id The record id.
   * @param plan The steps, in order.
   * @returns The record, or null when it is absent or settled.
   */
  async setPlan(id: string, plan: readonly TaskPlanStep[]): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskIsLive(record.status)) {
      return null;
    }
    record.plan = plan.map((step) => ({ text: step.text, state: step.state }));
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Replaces the checklist of one record. A goal whose text stays the same at the same place keeps
   * its proof, and every other goal starts open. Every live state accepts the checklist, and an
   * empty list clears it.
   *
   * @param id The record id.
   * @param texts The goal texts, in order.
   * @returns The record, or null when it is absent or settled.
   */
  async setGoals(id: string, texts: readonly string[]): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskIsLive(record.status)) {
      return null;
    }
    this.replaceGoals(record, texts);
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Meets one goal of the checklist with evidence the engine verified. The record must run.
   *
   * @param id The record id.
   * @param index The place of the goal in the checklist.
   * @param evidence The verified evidence of the proof.
   * @returns The record, or null when it is absent, does not run, or names no goal at that place.
   */
  async proveGoal(id: string, index: number, evidence: readonly TaskEvidence[]): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    const goal = record?.goals[index];
    if (!record || !goal || record.status !== 'running') {
      return null;
    }
    goal.met = true;
    goal.evidence = [...evidence];
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Moves a running record to blocked: its session asks the operator a question and waits for the
   * answer. The question lands on the record, the wall-clock clock stops for the wait, and the
   * settle listeners hear it, so the origin chat learns of the question. A blocked record frees
   * its place under the cap of the workspace.
   *
   * @param id The record id.
   * @param question The question of the session.
   * @returns The record, or null when the transition is forbidden.
   */
  async block(id: string, question: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'blocked')) {
      return null;
    }
    record.status = 'blocked';
    record.question = question;
    record.blockedAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.notifySettled(record);
    return record;
  }

  /**
   * Answers a blocked record: it moves back to running, the question clears, and the wall-clock
   * clock goes on from where it stopped.
   *
   * @param id The record id.
   * @returns The record, or null when the transition is forbidden.
   */
  async unblock(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || record.status !== 'blocked') {
      return null;
    }
    // The wait for the answer cost no time of the cap.
    if (record.blockedAt && record.startedAt) {
      const waited = Date.now() - Date.parse(record.blockedAt);
      record.startedAt = new Date(Date.parse(record.startedAt) + waited).toISOString();
    }
    record.status = 'running';
    record.question = null;
    record.blockedAt = null;
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Moves a blocked record back to the queue: its answer arrived while the workspace had no slot
   * for the record. The answer waits in the session of the record, so the record re-enters that
   * session: its dispatch mode becomes a session dispatch on the chat that ran it. The pump
   * dispatches it when a slot frees. The question clears, and the next dispatch starts a new
   * running stretch, so the wait costs no time of the clock.
   *
   * @param id The record id.
   * @returns The record, or null when it is absent or not blocked.
   */
  async requeue(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'queued')) {
      return null;
    }
    record.status = 'queued';
    record.dispatchMode = 'session';
    record.question = null;
    record.blockedAt = null;
    record.dispatchedAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Charges one provider round to the record its session runs: the tokens of the round and the
   * round itself join the spend of the task. A record in review still runs its session, so the
   * rounds after the completion signal count too. A settled record charges nothing.
   * A round of a running record tells no listener: the spend changes on every round, and the
   * surfaces would rebuild each time. The next change of the record carries the spend to them.
   * A round of a record in review tells the listeners, because those few rounds close the run,
   * and the surfaces then show the final spend of the task.
   *
   * @param id The record id.
   * @param promptTokens The prompt tokens of the round. Zero when the provider reported no usage.
   * @param completionTokens The completion tokens of the round.
   * @returns The record, or null when it is absent or settled.
   */
  async charge(id: string, promptTokens: number, completionTokens: number): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || (record.status !== 'running' && record.status !== 'review')) {
      return null;
    }
    record.tokensIn += promptTokens;
    record.tokensOut += completionTokens;
    record.turns += 1;
    await this.write(record);
    if (record.status === 'review') {
      this.emit();
    }
    return record;
  }

  /**
   * Ends a running record by a limit: a budget ran out, or the wall clock passed. The wrap-up of
   * the session ran first, so a summary the agent wrote stays on the record.
   *
   * @param id The record id.
   * @param status The end: exhausted for a budget, timeout for the wall clock.
   * @param cause The cause the record keeps.
   * @returns The record, or null when the transition is forbidden.
   */
  async endRun(id: string, status: 'exhausted' | 'timeout', cause: TaskEndCause): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, status)) {
      return null;
    }
    record.status = status;
    record.endCause = cause;
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.notifySettled(record);
    await this.settleWaitingChildren(record.id, 'failed', `ended as ${status}`);
    return record;
  }

  /**
   * Re-links the runtime chat id of one bound record after a restore. No status change.
   *
   * @param id The record id.
   * @param chatId The runtime chat id of the session that owns the record's session file.
   */
  async relink(id: string, chatId: number): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.sessionChatId === chatId) {
      return;
    }
    record.sessionChatId = chatId;
    await this.write(record);
  }

  /**
   * Updates the editable fields of one record. Every state accepts the edit: the fields carry
   * the brief and the goal, not the run state. An absent input field keeps its stored value. The
   * status input is the hand override of the user edit: it accepts every status, outside the
   * transition table, and settles or revives the record fields to match. A hand override that
   * moves a live record to review or a terminal state reaches the settle listeners, like the
   * review buttons do.
   *
   * @param id The record id.
   * @param input The fields to change. A title must stay non-empty.
   * @returns The record, or null when it is absent or the new title is empty.
   */
  async update(id: string, input: TaskUpdateInput): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record) {
      return null;
    }
    const { title = record.title, description = record.description, goal = record.goal, status } = input;
    if (title.length === 0) {
      return null;
    }
    record.title = title;
    record.description = description;
    record.goal = goal;
    // A cap the input names replaces the stored one, and null clears it.
    for (const key of ['maxTokens', 'maxTurns', 'timeoutMs'] as const) {
      if (Object.hasOwn(input, key)) {
        record[key] = input[key] ?? null;
      }
    }
    if (Object.hasOwn(input, 'priority')) {
      record.priority = readTaskPriority(input.priority);
    }
    if (Object.hasOwn(input, 'goals')) {
      this.replaceGoals(record, input.goals ?? []);
    }
    if (typeof input.category === 'string') {
      record.category = input.category;
    }
    let handSettle = false;
    if (status && status !== record.status) {
      handSettle = taskIsLive(record.status) && taskSettlesWaiter(status);
      record.status = status;
      if (taskIsLive(status)) {
        this.clearSettle(record);
      } else {
        record.note = null;
        record.endCause = 'user';
        record.settledAt = new Date().toISOString();
      }
    }
    await this.write(record);
    this.emit();
    if (handSettle) {
      this.notifySettled(record);
    }
    if (status && !taskIsLive(status) && status !== 'done') {
      // A hand settle fails or cancels the children the way the engine path does.
      const ended = status === 'failed' || status === 'exhausted' || status === 'timeout';
      await this.settleWaitingChildren(record.id, ended ? 'failed' : 'cancelled', `was set to ${status}`);
    }
    return record;
  }

  /**
   * Removes one record from memory and from its folder, live or archived. Every state accepts the
   * removal. The queued children of the record settle first, like they do on a failed blocker.
   *
   * @param id The record id.
   */
  async remove(id: string): Promise<void> {
    await this.settleWaitingChildren(id, 'cancelled', 'was removed');
    if (this.records.has(id)) {
      this.records.delete(id);
      await removePath(joinPath(this.root, `task-${id}.json`));
      this.emit();
      return;
    }
    if (this.archivedRecords.has(id)) {
      this.archivedRecords.delete(id);
      await removePath(joinPath(this.archiveRoot, `task-${id}.json`));
      this.emit();
    }
  }

  /**
   * Puts one settled record away: its file moves from the `tasks/` folder to the `archive/`
   * folder, and the record leaves the live lists. A live record stays where it is.
   *
   * @param id The record id.
   * @returns The record, or null when it is absent or still lives.
   */
  async archive(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || taskIsLive(record.status)) {
      return null;
    }
    await makeDirectory(this.archiveRoot);
    await renamePath(joinPath(this.root, `task-${id}.json`), joinPath(this.archiveRoot, `task-${id}.json`));
    this.records.delete(id);
    this.archivedRecords.set(id, record);
    this.emit();
    return record;
  }

  /**
   * Brings one archived record back: its file moves to the `tasks/` folder, and the record returns
   * to the live lists with the state it left with.
   *
   * @param id The record id.
   * @returns The record, or null when the archive holds no record of that id.
   */
  async restore(id: string): Promise<TaskRecord | null> {
    const record = this.archivedRecords.get(id);
    if (!record) {
      return null;
    }
    await renamePath(joinPath(this.archiveRoot, `task-${id}.json`), joinPath(this.root, `task-${id}.json`));
    this.archivedRecords.delete(id);
    this.records.set(id, record);
    this.emit();
    return record;
  }

  /** Writes one record to its file. */
  private async write(record: TaskRecord): Promise<void> {
    await writeTextFile(
      joinPath(this.root, `task-${record.id}.json`),
      JSON.stringify({ kind: 'task', ...record }, null, 2),
    );
  }
}
