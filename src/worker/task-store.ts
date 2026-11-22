/**
 * The store of the dispatchable task records, owned by the worker core. One JSON file per task
 * lives in the workspace `tasks/` folder, plain like the patch records, so a restart loses
 * nothing. The store owns the transition rules of `src/shared/tasks.ts`: every mutator refuses a
 * move the table forbids and answers null, so a caller never guesses the outcome. The renderers
 * reach the store through the core contract.
 */

import { readTaskRecord, taskCanTransition, taskIsLive, type TaskDispatchMode, type TaskRecord } from '../shared/tasks.js';
import { joinPath, listDirectoryNames, makeDirectory, readTextFile, removePath, writeTextFile } from './node-file-system.js';

/** The input of one create call. */
export interface TaskCreateInput {
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly origin: 'user' | 'agent';
  readonly originChatId: number | null;
  readonly parentTaskId: string | null;
  readonly blockedBy: readonly string[];
}

/** The editable fields of one record. An absent field keeps its stored value, and an empty
 * string clears it. */
export interface TaskUpdateInput {
  readonly title?: string;
  readonly description?: string;
  readonly goal?: string;
}

/** Owns the task records of the workspace. */
export class TaskStore {
  private readonly root: string;
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly settleListeners = new Set<(task: TaskRecord) => void>();

  /**
   * @param workspacePath The absolute path of the workspace directory, the parent of `tasks/`.
   */
  constructor(workspacePath: string) {
    this.root = joinPath(workspacePath, 'tasks');
  }

  /** Reads every stored record into memory. Call once at boot, before any tool runs. */
  async load(): Promise<void> {
    await makeDirectory(this.root);
    const names = await listDirectoryNames(this.root);
    if (!names) {
      return;
    }
    for (const name of names) {
      if (!name.startsWith('task-') || !name.endsWith('.json')) {
        continue;
      }
      const text = await readTextFile(joinPath(this.root, name));
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
        this.records.set(record.id, record);
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

  /** Reads every record, newest first. */
  list(): readonly TaskRecord[] {
    return [...this.records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Reads one record. */
  get(id: string): TaskRecord | null {
    return this.records.get(id) ?? null;
  }

  /** True when every blockedBy task of one record reached done. A missing reference blocks. */
  ready(record: TaskRecord): boolean {
    return record.blockedBy.every((id) => this.records.get(id)?.status === 'done');
  }

  /**
   * Creates one record. Every blockedBy id must name a known record, so a typo cannot block a
   * task forever.
   *
   * @param input The record facts.
   * @returns The record, or null when one blockedBy id is unknown.
   */
  async create(input: TaskCreateInput): Promise<TaskRecord | null> {
    for (const id of input.blockedBy) {
      if (!this.records.has(id)) {
        return null;
      }
    }
    const record: TaskRecord = {
      id: crypto.randomUUID(),
      title: input.title,
      description: input.description,
      goal: input.goal,
      origin: input.origin,
      originChatId: input.originChatId,
      parentTaskId: input.parentTaskId,
      blockedBy: [...input.blockedBy],
      status: 'draft',
      dispatchMode: null,
      sessionFileId: null,
      sessionChatId: null,
      result: null,
      evidence: null,
      note: null,
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

  /**
   * Reads the next queued task of one chat session, when one is ready. The queue order is the
   * dispatch order.
   *
   * @param sessionFileId The chat session file.
   * @returns The record, or null when no ready task waits for the session.
   */
  nextQueuedFor(sessionFileId: string): TaskRecord | null {
    const queued = this.list()
      .filter((record) => record.status === 'queued' && record.dispatchMode === 'session' && record.sessionFileId === sessionFileId)
      .sort((left, right) => (left.dispatchedAt ?? '').localeCompare(right.dispatchedAt ?? ''));
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
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Completes one record: running moves to review, and the summary with its evidence waits for
   * the user.
   *
   * @param id The record id.
   * @param result The completion summary.
   * @param evidence The evidence of the goal test, when one was written.
   * @returns The record, or null when the transition is forbidden.
   */
  async complete(id: string, result: string, evidence: string | null): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'review')) {
      return null;
    }
    record.status = 'review';
    record.result = result;
    record.evidence = evidence;
    await this.write(record);
    this.emit();
    this.settleListeners.forEach((listener) => {
      listener(record);
    });
    return record;
  }

  /**
   * Fails one record: running moves to failed on the word of the agent.
   *
   * @param id The record id.
   * @param note The reason, when one was written.
   * @returns The record, or null when the transition is forbidden.
   */
  async fail(id: string, note: string | null): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskCanTransition(record.status, 'failed')) {
      return null;
    }
    record.status = 'failed';
    record.note = note;
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.settleListeners.forEach((listener) => {
      listener(record);
    });
    return record;
  }

  /**
   * Cancels one record from any live state.
   *
   * @param id The record id.
   * @param note The reason, when one was written.
   * @returns The record, or null when the record is absent or already settled.
   */
  async cancel(id: string, note: string | null): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record || !taskIsLive(record.status) || !taskCanTransition(record.status, 'cancelled')) {
      return null;
    }
    record.status = 'cancelled';
    record.note = note;
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.settleListeners.forEach((listener) => {
      listener(record);
    });
    return record;
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
    record.settledAt = new Date().toISOString();
    await this.write(record);
    this.emit();
    this.settleListeners.forEach((listener) => {
      listener(record);
    });
    return record;
  }

  /**
   * Returns one review to the session: review moves back to running, and the comment of the user
   * rides to the agent as a re-brief. The old result and evidence clear, so the next completion
   * writes a fresh summary.
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
    record.result = null;
    record.evidence = null;
    await this.write(record);
    this.emit();
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
   * the brief and the goal, not the run state. An absent input field keeps its stored value.
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
    const { title = record.title, description = record.description, goal = record.goal } = input;
    if (title.length === 0) {
      return null;
    }
    record.title = title;
    record.description = description;
    record.goal = goal;
    await this.write(record);
    this.emit();
    return record;
  }

  /**
   * Removes one record from memory and from the workspace folder. Every state accepts the removal.
   *
   * @param id The record id.
   */
  async remove(id: string): Promise<void> {
    if (!this.records.has(id)) {
      return;
    }
    this.records.delete(id);
    await removePath(joinPath(this.root, `task-${id}.json`));
    this.emit();
  }

  /** Writes one record to its file. */
  private async write(record: TaskRecord): Promise<void> {
    await writeTextFile(
      joinPath(this.root, `task-${record.id}.json`),
      JSON.stringify({ kind: 'task', ...record }, null, 2),
    );
  }
}
