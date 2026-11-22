/**
 * The patch store of the workspace page: the client side of the store that lives in the worker
 * core. It keeps a local cache fed by the `patch.event` pushes, carries every action through the
 * core contract, and offers the interface the rail, the review view, the file tools, and the
 * main app always used. The records persist in the workspace `patches/` folder under the worker.
 */

import { readBridge, type NodeWavenBridge } from '../shared/bridge.js';
import { isRecord } from '../shared/records.js';
import { patchCounts, patchWaitsForReview, type CorePatchNotice, type CorePatchRecord, type CorePatchState, type CorePatchTask } from '../shared/core-api.js';

/** The states of one patch record. */
export type PatchState = CorePatchRecord['state'];

/** One patch proposal of the write tool. */
export type PatchRecord = CorePatchRecord;

/** One task the agent names with the task tool. Its title groups the patch events and renames the chat tab. */
export type TaskRecord = CorePatchTask;

/** One notice the store holds for the agent of one chat: a denial or a return with its comment. */
export type PatchNotice = CorePatchNotice;

export { patchCounts, patchWaitsForReview };

/** Reads one pushed or answered patch state. Returns null on an invalid shape. */
function readPatchState(value: unknown): CorePatchState | null {
  if (!isRecord(value) || !Array.isArray(value.patches) || !Array.isArray(value.tasks)) {
    return null;
  }
  return { patches: value.patches, tasks: value.tasks };
}

/** The patch store client of the workspace page. Every record lives in the worker core. */
export class PatchStore {
  private readonly bridge: NodeWavenBridge | null;
  private state: CorePatchState = { patches: [], tasks: [] };
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: PatchNotice) => void>();

  constructor() {
    this.bridge = readBridge();
    this.bridge?.workspace.onWorkspaceEvent('patch.event', (payload) => {
      const state = readPatchState(payload);
      if (state) {
        this.state = state;
        this.emit();
      }
    });
    this.bridge?.workspace.onWorkspaceEvent('patch.notice', (payload) => {
      if (isRecord(payload) && typeof payload.chatId === 'number' && typeof payload.text === 'string') {
        this.emitNotice({ chatId: payload.chatId, text: payload.text });
      }
    });
  }

  /** Reads the stored records into the cache. Call once at boot, before any tool runs. */
  async load(): Promise<void> {
    const state = readPatchState(await this.request('patch.list'));
    if (state) {
      this.state = state;
    }
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

  /** Reads every patch record, newest first. */
  listPatches(): readonly PatchRecord[] {
    return [...this.state.patches].sort((left, right) => right.id - left.id);
  }

  /** Reads one patch record. */
  patch(id: number): PatchRecord | null {
    return this.listPatches().find((record) => record.id === id) ?? null;
  }

  /** Reads every task record, newest first. */
  listTasks(): readonly TaskRecord[] {
    return [...this.state.tasks].sort((left, right) => right.id - left.id);
  }

  /** Reads the open task of one chat: the newest task without a close time, or null. */
  openTask(chatId: number): TaskRecord | null {
    let newest: TaskRecord | null = null;
    for (const task of this.state.tasks) {
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
   * Amends the open task of one chat, or starts a new one, in the worker core.
   *
   * @param chatId The chat that owns the task.
   * @param title The new title. An amend call keeps the old title when it omits one.
   * @param description The new description. An amend call keeps the old one when it omits one.
   * @param amend True to change the open task, false to start a new one.
   * @returns The task record.
   */
  async setTask(chatId: number, title: string | null, description: string | null, amend: boolean): Promise<TaskRecord> {
    return (await this.request('patch.task.set', { chatId, title, description, amend })) as TaskRecord;
  }

  /** Closes the open task of one chat, when the approve choice forces a new task. */
  async closeTask(chatId: number): Promise<void> {
    await this.request('patch.task.close', { chatId });
  }

  /**
   * Upserts the rolling patch of one chat and file in the worker core.
   *
   * @param chatId The chat whose agent writes. A runtime id, for routing and display.
   * @param sessionFileId The session file id of the chat, the identity that survives restores.
   * @param path The absolute path of the file.
   * @param oldText The live file text the patch builds on.
   * @param proposedText The text the agent proposes.
   * @returns The patch record.
   */
  async propose(
    chatId: number,
    sessionFileId: string | null,
    path: string,
    oldText: string,
    proposedText: string,
  ): Promise<PatchRecord> {
    return (await this.request('patch.propose', { chatId, sessionFileId, path, oldText, proposedText })) as PatchRecord;
  }

  /**
   * Applies one patch in the worker core: it re-reads the live file, applies with the offset
   * search and a small fuzz band, and writes the result.
   *
   * @param id The patch record id.
   * @returns The state after the attempt.
   */
  async apply(id: number): Promise<PatchState> {
    const state = await this.request('patch.apply', { id });
    return typeof state === 'string' ? (state as PatchState) : 'pending';
  }

  /**
   * Marks one patch denied in the worker core. The denial notice leaves for the agent of its chat.
   *
   * @param id The patch record id.
   * @param comment The comment of the user, when one was written.
   */
  async deny(id: number, comment: string | null = null): Promise<void> {
    await this.request('patch.deny', { id, comment });
  }

  /**
   * Marks one patch dismissed in the worker core: denied without any notice.
   *
   * @param id The patch record id.
   */
  async dismiss(id: number): Promise<void> {
    await this.request('patch.dismiss', { id });
  }

  /**
   * Deletes every resolved patch record in the worker core, and drops the closed tasks no
   * remaining record names. Records that wait for review stay.
   */
  async clearResolved(): Promise<void> {
    await this.request('patch.clear');
  }

  /**
   * Deletes one patch record in the worker core, whatever its state.
   *
   * @param id The patch record id.
   */
  async deletePatch(id: number): Promise<void> {
    await this.request('patch.delete', { id });
  }

  /** Runs one core request of the patch contract. */
  private async request(channel: string, payload?: unknown): Promise<unknown> {
    if (!this.bridge) {
      throw new Error('The patch store needs the nodewavenui bridge of an app window.');
    }
    return this.bridge.core.request(channel, payload);
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
}
