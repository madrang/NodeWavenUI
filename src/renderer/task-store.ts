/**
 * The task store of the workspace page: the client side of the store that lives in the worker
 * core. It keeps a local cache fed by the `task.event` pushes, carries every action through the
 * core contract, and offers the interface the task tool, the task board, and the main app always
 * used. The records persist in the workspace `tasks/` folder under the worker.
 */

import { readBridge, type NodeWavenBridge } from '../shared/bridge.js';
import { isRecord } from '../shared/records.js';
import type { CoreTaskCreateInput, CoreTaskState, CoreTaskUpdateInput } from '../shared/core-api.js';
import type { TaskRecord, TaskTemplate } from '../shared/tasks.js';

/** The input of one create call. */
export type TaskCreateInput = CoreTaskCreateInput;

/** The editable fields of one record. An absent field keeps its stored value, and an empty string clears it. */
export type TaskUpdateInput = CoreTaskUpdateInput;

/** Reads one pushed or answered task state. Returns null on an invalid shape. The archived records
 * and the templates ride along when the state carries them. */
function readTaskState(value: unknown): CoreTaskState | null {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return null;
  }
  return {
    records: value.records as readonly TaskRecord[],
    ...(Array.isArray(value.archived) ? { archived: value.archived as readonly TaskRecord[] } : {}),
    ...(Array.isArray(value.templates) ? { templates: value.templates as readonly TaskTemplate[] } : {}),
  };
}

/** The task store client of the workspace page. Every record lives in the worker core. */
export class TaskStore {
  private readonly bridge: NodeWavenBridge | null;
  private records: readonly TaskRecord[] = [];
  private archivedRecords: readonly TaskRecord[] = [];
  private templateList: readonly TaskTemplate[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly settleListeners = new Set<(task: TaskRecord) => void>();

  constructor() {
    this.bridge = readBridge();
    this.bridge?.workspace.onWorkspaceEvent('task.event', (payload) => {
      const state = readTaskState(payload);
      if (state) {
        this.take(state);
        this.emit();
      }
    });
    this.bridge?.workspace.onWorkspaceEvent('task.settle', (payload) => {
      if (isRecord(payload) && typeof payload.id === 'string') {
        for (const listener of this.settleListeners) {
          listener(payload as unknown as TaskRecord);
        }
      }
    });
  }

  /** Reads every stored record, archived record, and template into the cache. Call once at boot,
   * before any tool runs. */
  async load(): Promise<void> {
    const state = readTaskState(await this.request('task.list'));
    if (state) {
      this.take(state);
    }
  }

  /** Keeps the lists of one state of the core. A state that carries no archive and no templates
   * keeps the page with empty lists of them. */
  private take(state: CoreTaskState): void {
    this.records = state.records;
    this.archivedRecords = state.archived ?? [];
    this.templateList = state.templates ?? [];
  }

  /** Reads the archived records, newest first. */
  archived(): readonly TaskRecord[] {
    return [...this.archivedRecords].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Reads the task templates, newest first. */
  templates(): readonly TaskTemplate[] {
    return [...this.templateList].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

  /** Reads every record, newest first. */
  list(): readonly TaskRecord[] {
    return [...this.records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Reads one record. */
  get(id: string): TaskRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  /** True when every blockedBy task of one record reached done. A missing reference blocks. */
  ready(record: TaskRecord): boolean {
    return record.blockedBy.every((id) => this.records.find((candidate) => candidate.id === id)?.status === 'done');
  }

  /**
   * Creates one record in the worker core. Every blockedBy id must name a known record.
   *
   * @param input The record facts.
   * @returns The record, or null when one blockedBy id is unknown.
   */
  async create(input: TaskCreateInput): Promise<TaskRecord | null> {
    return (await this.request('task.create', { input })) as TaskRecord | null;
  }

  /**
   * Dispatches one record in the worker core: draft moves to queued.
   *
   * @param id The record id.
   * @param mode How the dispatch binds the session.
   * @param sessionFileId The chat session file, on session mode. Null on new-session mode.
   * @returns The record, or null when the transition is forbidden.
   */
  async dispatch(id: string, mode: 'new-session' | 'session', sessionFileId: string | null): Promise<TaskRecord | null> {
    return (await this.request('task.dispatch', { id, mode, sessionFileId })) as TaskRecord | null;
  }

  /**
   * Returns one failed record and the children it failed to the queue in the worker core, on the
   * session the call names.
   *
   * @param id The record id.
   * @param mode How the retry binds the session.
   * @param sessionFileId The chat session file, on session mode. Null on new-session mode.
   * @returns The outcome text of the engine.
   */
  async retry(id: string, mode: 'new-session' | 'session', sessionFileId: string | null): Promise<string> {
    return (await this.request('task.retry', { id, mode, sessionFileId })) as string;
  }

  /**
   * Reads the next queued task of one chat session, when one is ready. The queue order is the
   * dispatch order.
   *
   * @param sessionFileId The chat session file.
   * @returns The record, or null when no ready task waits for the session.
   */
  async nextQueuedFor(sessionFileId: string): Promise<TaskRecord | null> {
    return (await this.request('task.next', { sessionFileId })) as TaskRecord | null;
  }

  /**
   * Binds one record to the chat that runs it and moves it to running.
   *
   * @param id The record id.
   * @param chatId The runtime chat id of the session.
   * @param sessionFileId The persisted chat session file.
   * @returns The record, or null when the transition is forbidden.
   */
  async bindSession(id: string, chatId: number, sessionFileId: string): Promise<TaskRecord | null> {
    return (await this.request('task.bind', { id, chatId, sessionFileId })) as TaskRecord | null;
  }

  /**
   * Completes one record in the worker core: running moves to review.
   *
   * @param id The record id.
   * @param result The completion summary.
   * @param evidence The evidence of the goal test, when one was written.
   * @returns The record, or null when the transition is forbidden.
   */
  async complete(id: string, result: string, evidence: string | null): Promise<TaskRecord | null> {
    return (await this.request('task.complete', { id, result, evidence })) as TaskRecord | null;
  }

  /**
   * Fails one record in the worker core: running moves to failed on the word of the agent.
   *
   * @param id The record id.
   * @param note The reason, when one was written.
   * @returns The record, or null when the transition is forbidden.
   */
  async fail(id: string, note: string | null): Promise<TaskRecord | null> {
    return (await this.request('task.fail', { id, note })) as TaskRecord | null;
  }

  /**
   * Cancels one record in the worker core, from any live state.
   *
   * @param id The record id.
   * @param note The reason, when one was written.
   * @returns The record, or null when the record is absent or already settled.
   */
  async cancel(id: string, note: string | null): Promise<TaskRecord | null> {
    return (await this.request('task.cancel', { id, note })) as TaskRecord | null;
  }

  /**
   * Accepts one review in the worker core: review moves to done.
   *
   * @param id The record id.
   * @returns The record, or null when the transition is forbidden.
   */
  async accept(id: string): Promise<TaskRecord | null> {
    return (await this.request('task.accept', { id })) as TaskRecord | null;
  }

  /**
   * Returns one review to the session in the worker core: review moves back to running.
   *
   * @param id The record id.
   * @returns The record, or null when the transition is forbidden.
   */
  async returnToSession(id: string): Promise<TaskRecord | null> {
    return (await this.request('task.return', { id })) as TaskRecord | null;
  }

  /**
   * Reopens one settled record in the worker core: done, failed, or cancelled moves back to draft.
   *
   * @param id The record id.
   * @returns The record, or null when the record is absent or still lives.
   */
  async reopen(id: string): Promise<TaskRecord | null> {
    return (await this.request('task.reopen', { id })) as TaskRecord | null;
  }

  /**
   * Re-links the runtime chat id of one bound record after a restore. No status change.
   *
   * @param id The record id.
   * @param chatId The runtime chat id of the session that owns the record's session file.
   */
  async relink(id: string, chatId: number): Promise<void> {
    await this.request('task.relink', { id, chatId });
  }

  /**
   * Updates the editable fields of one record in the worker core.
   *
   * @param id The record id.
   * @param input The fields to change. A title must stay non-empty.
   * @returns The record, or null when it is absent or the new title is empty.
   */
  async update(id: string, input: TaskUpdateInput): Promise<TaskRecord | null> {
    return (await this.request('task.update', { id, input })) as TaskRecord | null;
  }

  /**
   * Removes one record in the worker core, from memory and from the workspace folder.
   *
   * @param id The record id.
   */
  async remove(id: string): Promise<void> {
    await this.request('task.remove', { id });
  }

  /**
   * Answers the question of a blocked record in the worker core: the record runs again, and the
   * answer lands in its session as the next message.
   *
   * @param id The record id.
   * @param answer The answer of the operator.
   * @returns The outcome text of the engine.
   */
  async answer(id: string, answer: string): Promise<string> {
    return (await this.request('task.answer', { id, answer })) as string;
  }

  /**
   * Puts one settled record away in the worker core: its file moves to the `archive/` folder, and
   * the record leaves the live lists.
   *
   * @param id The record id.
   * @returns The record, or null when it is absent or still lives.
   */
  async archive(id: string): Promise<TaskRecord | null> {
    return (await this.request('task.archive', { id })) as TaskRecord | null;
  }

  /**
   * Brings one archived record back to the live lists, with the state it left with.
   *
   * @param id The record id.
   * @returns The record, or null when the archive holds none of that id.
   */
  async restore(id: string): Promise<TaskRecord | null> {
    return (await this.request('task.restore', { id })) as TaskRecord | null;
  }

  /**
   * Saves one record as a task template: the template keeps its brief, its checklist, its plan,
   * and its category.
   *
   * @param id The record id.
   * @returns The template.
   */
  async saveTemplate(id: string): Promise<TaskTemplate> {
    return (await this.request('task.template.save', { id })) as TaskTemplate;
  }

  /**
   * Removes one task template. The tasks that came from it stay as they are.
   *
   * @param id The template id.
   */
  async removeTemplate(id: string): Promise<void> {
    await this.request('task.template.remove', { id });
  }

  /** Runs one core request of the task contract. */
  private async request(channel: string, payload?: unknown): Promise<unknown> {
    if (!this.bridge) {
      throw new Error('The task store needs the nodewavenui bridge of an app window.');
    }
    return this.bridge.core.request(channel, payload);
  }

  /** Fires every record listener. */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
