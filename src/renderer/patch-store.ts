/**
 * The patch records of the write tool and the task records that group them. Every agent write
 * becomes one patch proposal that waits for the user review, and the records persist in the
 * workspace `patches/` folder until they apply, so a restart loses nothing. One chat works one
 * rolling patch per task and file: a later write refreshes the pending record, and a review
 * closes it, so the next write opens a fresh patch under the same task.
 */

import { applyPatch, createPatch } from './libs/diff/index.js';
import { joinPath, listDirectoryNames, makeDirectory, readTextFile, removePath, statPath, writeTextFile } from './file-system.js';

/** The states of one patch record. */
export type PatchState = 'pending' | 'applied' | 'denied' | 'dismissed' | 'conflicted';

/** One patch proposal of the write tool. */
export interface PatchRecord {
  readonly id: number;
  /** The absolute path of the file the patch changes. */
  readonly path: string;
  /** The chat whose agent proposed the patch. */
  readonly chatId: number;
  /** The task the patch belongs to, or null when the agent named no task. */
  readonly taskId: number | null;
  /** The unified diff text. */
  patch: string;
  state: PatchState;
  /** The comment of a return or a denied review, when the user wrote one. */
  comment: string | null;
  readonly createdAt: string;
  resolvedAt: string | null;
}

/** One task the agent names with the task tool. Its title groups the patch events and renames the chat tab. */
export interface TaskRecord {
  readonly id: number;
  readonly chatId: number;
  title: string;
  description: string | null;
  readonly createdAt: string;
  /** Set when the task closed: by a new task, or by the approve choice of the user. */
  closedAt: string | null;
}

/** One notice the store holds for the agent of one chat: a denial or a return with its comment. */
export interface PatchNotice {
  readonly chatId: number;
  readonly text: string;
}

/** Reads one record shape guard: every field keeps its type, or the record drops. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Checks that a value is one patch state. */
function isPatchState(value: unknown): value is PatchState {
  return value === 'pending' || value === 'applied' || value === 'denied' || value === 'dismissed' || value === 'conflicted';
}

/** Reads the patch states that still wait for the user. */
export function patchWaitsForReview(state: PatchState): boolean {
  return state === 'pending' || state === 'conflicted';
}

/** Counts the line additions and removals of one patch text. */
export function patchCounts(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1;
    }
  }
  return { added, removed };
}

/** Owns the patch and task records of the workspace. */
export class PatchStore {
  private readonly workspacePath: string;
  private readonly root: string;
  private readonly patches = new Map<number, PatchRecord>();
  private readonly tasks = new Map<number, TaskRecord>();
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: PatchNotice) => void>();

  /**
   * @param workspacePath The absolute path of the workspace directory, the parent of `patches/`.
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.root = joinPath(workspacePath, 'patches');
  }

  /** Reads every stored record into memory. Call once at boot, before any tool runs. */
  async load(): Promise<void> {
    await makeDirectory(this.root);
    const names = await listDirectoryNames(this.root);
    if (!names) {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) {
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
      if (!isRecord(value)) {
        continue;
      }
      if (value['kind'] === 'patch') {
        const record = this.readPatchShape(value);
        if (record) {
          this.patches.set(record.id, record);
        }
      }
      if (value['kind'] === 'task') {
        const task = this.readTaskShape(value);
        if (task) {
          this.tasks.set(task.id, task);
        }
      }
    }
    const ids = [...this.patches.keys(), ...this.tasks.keys()];
    this.nextId = (Math.max(0, ...ids) ?? 0) + 1;
  }

  /** Reads one stored patch record, or null on an invalid shape. */
  private readPatchShape(record: Record<string, unknown>): PatchRecord | null {
    const { id, path, chatId, taskId, patch, state, comment, createdAt, resolvedAt } = record;
    if (
      typeof id !== 'number' || typeof path !== 'string' || typeof chatId !== 'number' ||
      (taskId && typeof taskId !== 'number') || typeof patch !== 'string' || !isPatchState(state) ||
      (comment && typeof comment !== 'string') || typeof createdAt !== 'string' ||
      (resolvedAt && typeof resolvedAt !== 'string')
    ) {
      return null;
    }
    return {
      id,
      path,
      chatId,
      taskId: typeof taskId === 'number' ? taskId : null,
      patch,
      state,
      comment: typeof comment === 'string' ? comment : null,
      createdAt,
      resolvedAt: typeof resolvedAt === 'string' ? resolvedAt : null,
    };
  }

  /** Reads one stored task record, or null on an invalid shape. */
  private readTaskShape(record: Record<string, unknown>): TaskRecord | null {
    const { id, chatId, title, description, createdAt, closedAt } = record;
    if (
      typeof id !== 'number' || typeof chatId !== 'number' || typeof title !== 'string' ||
      (description && typeof description !== 'string') || typeof createdAt !== 'string' ||
      (closedAt && typeof closedAt !== 'string')
    ) {
      return null;
    }
    return {
      id,
      chatId,
      title,
      description: typeof description === 'string' ? description : null,
      createdAt,
      closedAt: typeof closedAt === 'string' ? closedAt : null,
    };
  }

  /** Subscribes to every record change. The listener holds no arguments: it re-reads the lists. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribes to the notices for the agents: denials and returns with their comments. */
  onNotice(listener: (notice: PatchNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }

  /** Fires every record listener. */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Fires one notice listener set. */
  private emitNotice(notice: PatchNotice): void {
    for (const listener of this.noticeListeners) {
      listener(notice);
    }
  }

  /** Reads every patch record, newest first. */
  listPatches(): readonly PatchRecord[] {
    return [...this.patches.values()].sort((left, right) => right.id - left.id);
  }

  /** Reads one patch record. */
  patch(id: number): PatchRecord | null {
    return this.patches.get(id) ?? null;
  }

  /** Reads every task record, newest first. */
  listTasks(): readonly TaskRecord[] {
    return [...this.tasks.values()].sort((left, right) => right.id - left.id);
  }

  /** Reads the open task of one chat: the newest task without a close time, or null. */
  openTask(chatId: number): TaskRecord | null {
    let newest: TaskRecord | null = null;
    for (const task of this.tasks.values()) {
      if (task.chatId !== chatId || task.closedAt) {
        continue;
      }
      if (!newest || task.id > newest.id) {
        newest = task;
      }
    }
    return newest;
  }

  /** Reads the title of the open task of one chat, for the chat tab. */
  openTaskTitle(chatId: number): string | null {
    return this.openTask(chatId)?.title ?? null;
  }

  /**
   * Amends the open task of one chat, or starts a new one. A new task closes the open task first,
   * so its rolling patches end with it.
   *
   * @param chatId The chat that owns the task.
   * @param title The new title. An amend call keeps the old title when it omits one.
   * @param description The new description. An amend call keeps the old one when it omits one.
   * @param amend True to change the open task, false to start a new one.
   * @returns The task record.
   */
  async setTask(chatId: number, title: string | null, description: string | null, amend: boolean): Promise<TaskRecord> {
    const open = this.openTask(chatId);
    if (amend && open) {
      if (title) {
        open.title = title;
      }
      if (description) {
        open.description = description;
      }
      await this.writeTask(open);
      this.emit();
      return open;
    }
    const now = new Date().toISOString();
    if (open) {
      open.closedAt = now;
      await this.writeTask(open);
    }
    const task: TaskRecord = {
      id: this.nextId,
      chatId,
      title: title ?? 'Untitled task',
      description,
      createdAt: now,
      closedAt: null,
    };
    this.nextId += 1;
    this.tasks.set(task.id, task);
    await this.writeTask(task);
    this.emit();
    return task;
  }

  /** Closes the open task of one chat, when the approve choice forces a new task. */
  async closeTask(chatId: number): Promise<void> {
    const open = this.openTask(chatId);
    if (!open) {
      return;
    }
    open.closedAt = new Date().toISOString();
    await this.writeTask(open);
    this.emit();
  }

  /**
   * Upserts the rolling patch of one chat and file. A pending record for the same chat and path
   * refreshes in place, so the review sees the whole task as one change. Any other state closes
   * that record first, and the write opens a fresh one under the open task.
   *
   * @param chatId The chat whose agent writes.
   * @param path The absolute path of the file.
   * @param oldText The live file text the patch builds on.
   * @param proposedText The text the agent proposes.
   * @returns The patch record.
   */
  async propose(chatId: number, path: string, oldText: string, proposedText: string): Promise<PatchRecord> {
    const open = this.openTask(chatId);
    const rolling = [...this.patches.values()]
      .filter((record) => record.chatId === chatId && record.path === path && patchWaitsForReview(record.state))
      .sort((left, right) => right.id - left.id)
      .at(0) ?? null;
    const patch = createPatch(this.displayPath(path), oldText, proposedText);
    if (rolling) {
      rolling.patch = patch;
      await this.writePatch(rolling);
      this.emit();
      return rolling;
    }
    const record: PatchRecord = {
      id: this.nextId,
      path,
      chatId,
      taskId: open?.id ?? null,
      patch,
      state: 'pending',
      comment: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.nextId += 1;
    this.patches.set(record.id, record);
    await this.writePatch(record);
    this.emit();
    return record;
  }

  /** Reads the workspace-relative path one patch header and the review show. */
  private displayPath(path: string): string {
    const root = this.workspacePath.replace(/[\\/]+$/, '');
    return path === root ? '.' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  }

  /**
   * Applies one patch: re-reads the live file, applies with the offset search and a small fuzz
   * band, and writes through the bridge fs. A full mismatch moves the record to the conflict
   * state instead of guessing.
   *
   * @param id The patch record id.
   * @returns The state after the attempt.
   */
  async apply(id: number): Promise<PatchState> {
    const record = this.patches.get(id);
    if (!record || !patchWaitsForReview(record.state)) {
      return record?.state ?? 'pending';
    }
    // A creation patch builds on an absent file, so a missing path reads as empty text.
    const present = await statPath(record.path);
    const live = present ? await readTextFile(record.path) : '';
    // eslint-disable-next-line local/prefer-truthiness -- an empty file reads as an empty string, only a failed read conflicts
    if (live === null) {
      return this.markConflicted(record, 'The file no longer reads.');
    }
    const merged = applyPatch(live, record.patch, { fuzzFactor: 2 });
    // eslint-disable-next-line local/prefer-truthiness -- an empty merged file is a valid apply, only the false return conflicts
    if (merged === false) {
      return this.markConflicted(record, 'The file drifted under the patch, so it no longer applies.');
    }
    await writeTextFile(record.path, merged);
    record.state = 'applied';
    record.resolvedAt = new Date().toISOString();
    await this.writePatch(record);
    this.emit();
    return record.state;
  }

  /** Moves one record to the conflict state and notes the reason as its comment. */
  private async markConflicted(record: PatchRecord, reason: string): Promise<PatchState> {
    record.state = 'conflicted';
    record.comment = reason;
    record.resolvedAt = new Date().toISOString();
    await this.writePatch(record);
    this.emit();
    return record.state;
  }

  /**
   * Marks one patch denied. The denial notice leaves for the agent of its chat at once, and a
   * written comment rides with it.
   *
   * @param id The patch record id.
   * @param comment The comment of the user, when one was written.
   */
  async deny(id: number, comment: string | null = null): Promise<void> {
    const record = this.patches.get(id);
    if (!record || !patchWaitsForReview(record.state)) {
      return;
    }
    record.state = 'denied';
    record.comment = comment;
    record.resolvedAt = new Date().toISOString();
    await this.writePatch(record);
    this.emit();
    this.emitNotice({
      chatId: record.chatId,
      text: comment ?
        `[patch review] The user denied the patch for ${record.path} with a comment:\n${comment}\nRe-read the file and propose a changed patch.` :
        `[patch review] The user denied the patch for ${record.path}. The file stayed unchanged. Propose a different change or move on.`,
    });
  }

  /**
   * Marks one patch dismissed: denied without any notice, so the agent of its chat hears nothing.
   *
   * @param id The patch record id.
   */
  async dismiss(id: number): Promise<void> {
    const record = this.patches.get(id);
    if (!record || !patchWaitsForReview(record.state)) {
      return;
    }
    record.state = 'dismissed';
    record.resolvedAt = new Date().toISOString();
    await this.writePatch(record);
    this.emit();
  }

  /**
   * Deletes every resolved patch record, from memory and from the workspace folder, and drops
   * the closed tasks no remaining record names. Records that wait for review stay.
   */
  async clearResolved(): Promise<void> {
    const removed: number[] = [];
    for (const record of this.patches.values()) {
      if (!patchWaitsForReview(record.state)) {
        removed.push(record.id);
      }
    }
    for (const id of removed) {
      this.patches.delete(id);
      await removePath(joinPath(this.root, `patch-${id}.json`));
    }
    const stillReferenced = new Set(
      [...this.patches.values()].map((record) => record.taskId).filter((taskId): taskId is number => taskId !== null),
    );
    for (const task of this.tasks.values()) {
      if (task.closedAt && !stillReferenced.has(task.id)) {
        this.tasks.delete(task.id);
        await removePath(joinPath(this.root, `task-${task.id}.json`));
      }
    }
    this.emit();
  }

  /**
   * Deletes one patch record, whatever its state, from memory and from the workspace folder. A
   * waiting record leaves without a notice: the review drops, the file never changes.
   *
   * @param id The patch record id.
   */
  async deletePatch(id: number): Promise<void> {
    const record = this.patches.get(id);
    if (!record) {
      return;
    }
    this.patches.delete(id);
    await removePath(joinPath(this.root, `patch-${id}.json`));
    this.emit();
  }

  /** Writes one patch record to its file. */
  private async writePatch(record: PatchRecord): Promise<void> {
    await writeTextFile(
      joinPath(this.root, `patch-${record.id}.json`),
      JSON.stringify({ kind: 'patch', ...record }, null, 2),
    );
  }

  /** Writes one task record to its file. */
  private async writeTask(task: TaskRecord): Promise<void> {
    await writeTextFile(
      joinPath(this.root, `task-${task.id}.json`),
      JSON.stringify({ kind: 'task', ...task }, null, 2),
    );
  }
}
