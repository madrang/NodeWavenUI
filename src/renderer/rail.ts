/**
 * The left rail of the workspace window: a strip of section icons beside the open panel.
 * The events panel lists two sources in one feed: the permission requests of the gate and the
 * patch proposals of the write tool. A request waits as a pending row until the approval card of
 * its tab resolves it, and a patch waits until the user reviews it. A pending approval row click
 * activates the tab that holds the card, and a pending patch row click opens its review in the
 * center workspace. The files panel lists the workspace directory as a read-only tree with lazy
 * folder expansion. An icon click on the open section minimizes the rail to the strip, and any
 * icon click opens its section again.
 */

import type { PermissionGate, PermissionRequestInfo } from './permission-gate.js';
import { showContextMenu } from './context-menu.js';
import { requireElement } from './dom.js';
import { joinPath, listDirectoryNames, statPath } from './file-system.js';
import { patchCounts, patchWaitsForReview, type PatchStore } from './patch-store.js';
import type { TaskStatus } from '../shared/tasks.js';
import type { TaskStore } from './task-store.js';

/** The dependencies the rail works with. */
export interface RailDeps {
  /** The permission gate whose pending requests feed the events tab. Null before one exists. */
  readonly gate: PermissionGate | null;
  /** The absolute path of the workspace directory, the root of the files tree. */
  readonly workspacePath: string;
  /** Activates the tab that owns one pending request source. */
  readonly openTab: (source: string | null) => void;
  /** The patch store whose records feed the events tab as the second source. Null before it loads. */
  readonly patchStore: PatchStore | null;
  /** Opens the review of one patch in the center workspace. The flag opens it in its own tab. */
  readonly openPatch: (id: number, separateTab: boolean) => void;
  /** The task store whose records feed the events tab as the third source. Null before it loads. */
  readonly taskStore: TaskStore | null;
  /** Opens the task board in the center workspace. */
  readonly openTaskBoard: () => void;
}

/** One row of the events feed: one approval request, one patch proposal, or one task record. */
interface RailEvent {
  readonly id: number | string;
  readonly kind: 'approval' | 'patch' | 'task';
  readonly title: string;
  readonly meta: string;
  readonly time: string;
  /** The epoch time the row last changed, so every source sorts together. */
  readonly sortTime: number;
  state: 'pending' | 'live' | 'completed';
  outcome: 'approved' | 'denied' | 'resolved' | 'applied' | 'dismissed' | TaskStatus | null;
  /** True on a patch whose apply failed, so the conflict still waits. */
  conflicted: boolean;
}

/** One lazy folder of the files tree. */
interface TreeFolder {
  readonly children: HTMLElement;
  loaded: boolean;
  open: boolean;
}

/** Reads the row title of one request: the action over the target. */
function eventTitleOf(request: PermissionRequestInfo): string {
  return `${request.action} — ${request.target}`;
}

/** Reads the row meta of one request: the principal and the source that asked. */
function eventMetaOf(request: PermissionRequestInfo): string {
  return request.source ? `${request.principal} · ${request.source}` : request.principal;
}

/** Reads the icon class of one file name: the extension, or the folder mark. */
function fileIconClass(name: string, directory: boolean): string {
  if (directory) {
    return 'folder';
  }
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return /^[a-z0-9]+$/.test(extension) ? extension : 'file';
}

/** Drives the left rail. */
export class AppRail {
  private readonly deps: RailDeps;
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly panels = new Map<string, HTMLElement>();
  private readonly column: HTMLElement;
  private readonly eventList: HTMLElement;
  private readonly eventCount: HTMLElement;
  private readonly fileTree: HTMLElement;
  private activeTab: string | null = null;
  private minimized = false;
  private openWidth = '';
  private filter: 'all' | 'pending' | 'completed' = 'all';
  private readonly events: RailEvent[] = [];
  private readonly folders = new Map<HTMLElement, TreeFolder>();

  /**
   * @param deps The gate, the workspace path, and the tab activation callback.
   */
  constructor(deps: RailDeps) {
    this.deps = deps;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.rail-tab')) {
      const tab = button.dataset.railTab;
      if (tab) {
        this.tabButtons.set(tab, button);
      }
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.rail-panel')) {
      const name = panel.dataset.railPanel;
      if (name) {
        this.panels.set(name, panel);
      }
    }
    for (const [name, button] of this.tabButtons) {
      if (button.classList.contains('active')) {
        this.activeTab = name;
      }
    }
    this.column = requireElement<HTMLElement>('#rail-left');
    this.eventList = requireElement<HTMLElement>('#rail-event-list');
    this.eventCount = requireElement<HTMLElement>('#rail-event-count');
    this.fileTree = requireElement<HTMLElement>('#rail-file-tree');
  }

  /**
   * Wires the tab switches, the filters, the gate subscription, and the tree root.
   * Call after the gate finished its lazy rule load, so the first snapshot reads the truth.
   */
  start(): void {
    for (const [name, button] of this.tabButtons) {
      button.addEventListener('click', () => {
        this.activate(name);
      });
    }
    for (const chip of document.querySelectorAll<HTMLButtonElement>('.rail-chip')) {
      const value = chip.dataset.railFilter;
      if (value !== 'all' && value !== 'pending' && value !== 'completed') {
        continue;
      }
      chip.addEventListener('click', () => {
        this.filter = value;
        this.renderFilters();
        this.renderEvents();
      });
    }
    requireElement<HTMLButtonElement>('#rail-event-clear').addEventListener('click', () => {
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        const event = this.events[index];
        if (event?.state === 'completed') {
          this.events.splice(index, 1);
        }
      }
      // One clear serves both sources: the completed approvals drop from the feed, and the
      // resolved patch records delete from the workspace folder.
      void this.deps.patchStore?.clearResolved();
      this.renderEvents();
    });
    this.deps.gate?.subscribe(() => {
      this.syncPending();
    });
    this.deps.patchStore?.subscribe(() => {
      this.renderEvents();
    });
    this.deps.taskStore?.subscribe(() => {
      this.renderEvents();
    });
    this.syncPending();
    void this.mountFolder(this.fileTree, this.deps.workspacePath, 0);
  }

  /** Records the outcome of one request the approval card of a tab resolved. */
  noteResolution(id: number, approve: boolean): void {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event || event.state === 'completed') {
      return;
    }
    event.state = 'completed';
    event.outcome = approve ? 'approved' : 'denied';
    this.renderEvents();
  }

  /** Reads the pending requests of the gate into the feed: new ids join as pending, missing ids complete. */
  private syncPending(): void {
    const pending = this.deps.gate?.pendingRequests() ?? [];
    const live = new Set(pending.map((request) => request.id));
    for (const event of this.events) {
      if (event.state === 'pending' && typeof event.id === 'number' && !live.has(event.id)) {
        // The request left the queue outside the rail, for example through a rule change.
        event.state = 'completed';
        event.outcome = 'resolved';
      }
    }
    for (const request of pending) {
      if (this.events.some((event) => event.id === request.id && event.kind === 'approval')) {
        continue;
      }
      const arrived = Date.now();
      this.events.unshift({
        id: request.id,
        kind: 'approval',
        title: eventTitleOf(request),
        meta: eventMetaOf(request),
        time: new Date(arrived).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        sortTime: arrived,
        state: 'pending',
        outcome: null,
        conflicted: false,
      });
    }
    this.renderEvents();
  }

  /** Reads the patch records of the store as feed rows, the second source of the events tab. */
  private patchRows(): RailEvent[] {
    const store = this.deps.patchStore;
    if (!store) {
      return [];
    }
    const tasks = new Map(store.listTasks().map((task) => [task.id, task]));
    return store.listPatches().map((record) => {
      const waiting = patchWaitsForReview(record.state);
      const counts = patchCounts(record.patch);
      const file = record.path.split('/').at(-1) ?? record.path;
      const task = record.taskId ? tasks.get(record.taskId) : undefined;
      return {
        id: record.id,
        kind: 'patch',
        title: `${file} (+${counts.added} -${counts.removed})`,
        meta: `patch · ${task?.title ?? 'no task'}`,
        time: new Date(record.resolvedAt ?? record.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        sortTime: Date.parse(record.resolvedAt ?? record.createdAt) || Date.parse(record.createdAt) || 0,
        state: (waiting ? 'pending' : 'completed') as RailEvent['state'],
        outcome: (waiting ? null : record.state) as RailEvent['outcome'],
        conflicted: record.state === 'conflicted',
      };
    });
  }

  /** Reads the task records of the store as feed rows, the third source of the events tab. A
   * review row waits for the user; the live states show the work in flight; a settle completes. */
  private taskRows(): RailEvent[] {
    const store = this.deps.taskStore;
    if (!store) {
      return [];
    }
    return store.list().map((task) => {
      const live = task.status === 'draft' || task.status === 'queued' || task.status === 'running';
      const waiting = task.status === 'review';
      const stamp = Date.parse(task.settledAt ?? task.dispatchedAt ?? task.createdAt) || 0;
      const origin = task.origin === 'user' ? 'user' : `agent · ${task.parentTaskId ? 'child of ' + task.parentTaskId.slice(0, 8) : 'top'}`;
      return {
        id: task.id,
        kind: 'task',
        title: task.title,
        meta: `task · ${task.status} · ${origin}`,
        time: new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        sortTime: stamp,
        state: (waiting ? 'pending' : live ? 'live' : 'completed') as RailEvent['state'],
        outcome: (waiting || live ? null : task.status) as RailEvent['outcome'],
        conflicted: false,
      };
    });
  }

  /** Handles one icon click: switches the section, or minimizes the rail when the section is open. */
  private activate(name: string): void {
    if (!this.minimized && this.activeTab === name) {
      this.minimize();
      return;
    }
    this.showTab(name);
  }

  /** Shrinks the rail to the icon strip and hides the panels. No icon reads active while none shows. */
  private minimize(): void {
    this.minimized = true;
    this.openWidth = this.column.style.width;
    this.column.style.width = '';
    this.column.classList.add('minimized');
    for (const button of this.tabButtons.values()) {
      button.classList.remove('active');
    }
  }

  /** Shows one rail section, and restores the rail width after a minimize. */
  private showTab(name: string): void {
    this.activeTab = name;
    if (this.minimized) {
      this.minimized = false;
      this.column.classList.remove('minimized');
      this.column.style.width = this.openWidth;
    }
    for (const [tab, button] of this.tabButtons) {
      button.classList.toggle('active', tab === name);
    }
    for (const [panel, element] of this.panels) {
      element.hidden = panel !== name;
    }
  }

  /** Re-renders the filter chips from the active filter. */
  private renderFilters(): void {
    for (const chip of document.querySelectorAll<HTMLButtonElement>('.rail-chip')) {
      chip.classList.toggle('active', chip.dataset.railFilter === this.filter);
    }
  }

  /** Re-renders the events feed and the pending count. The waiting events pin to the top, oldest
   * first, so nothing that needs an answer sinks under the history. The live task rows follow,
   * then the completed events, newest first. */
  private renderEvents(): void {
    this.eventList.replaceChildren();
    const rank = (event: RailEvent): number => (event.state === 'pending' ? 0 : event.state === 'live' ? 1 : 2);
    const merged = [...this.events, ...this.patchRows(), ...this.taskRows()].sort((left, right) => {
      const order = rank(left) - rank(right);
      if (order !== 0) {
        return order;
      }
      return rank(left) === 2 ? right.sortTime - left.sortTime : left.sortTime - right.sortTime;
    });
    const visible = merged.filter((event) =>
      this.filter === 'all' ? true : this.filter === 'pending' ? event.state === 'pending' : event.state === 'completed',
    );
    for (const event of visible) {
      const row = document.createElement('div');
      const classes = ['rail-event', event.state, event.kind];
      if (event.conflicted) {
        classes.push('conflicted');
      }
      if (event.state === 'completed' && event.outcome === 'denied') {
        classes.push('denied');
      }
      row.className = classes.join(' ');
      const body = document.createElement('div');
      body.className = 'rail-event-body';
      const title = document.createElement('div');
      title.className = 'rail-event-title';
      title.textContent = event.title;
      const meta = document.createElement('div');
      meta.className = 'rail-event-meta';
      meta.textContent = event.state === 'completed' ? `${event.meta} · ${event.outcome}` : event.meta;
      body.append(title, meta);
      const time = document.createElement('span');
      time.className = 'rail-event-time';
      time.textContent = event.time;
      row.append(body, time);
      if (event.state === 'pending' && event.kind === 'approval') {
        row.title = 'Open the tab that holds the approval card.';
        row.addEventListener('click', () => {
          const request = this.deps.gate?.pendingRequests().find((candidate) => candidate.id === event.id);
          if (request) {
            this.deps.openTab(request.source);
          }
        });
      }
      // Every task row opens the board, which carries the dispatch and the review actions.
      if (event.kind === 'task') {
        row.title = 'Open the task board.';
        row.addEventListener('click', () => {
          this.deps.openTaskBoard();
        });
      }
      // The right click of one event row offers its single deletion: one patch record, or one
      // completed approval row. A waiting approval card answers no deletion, so it opens none.
      row.addEventListener('contextmenu', (menu) => {
        menu.preventDefault();
        if (event.kind === 'patch') {
          showContextMenu(menu.clientX, menu.clientY, [
            {
              label: 'Delete patch record',
              danger: true,
              title: 'Deletes the record and its file. A waiting patch leaves without a notice.',
              run: () => {
                if (typeof event.id === 'number') {
                  void this.deps.patchStore?.deletePatch(event.id);
                }
              },
            },
          ]);
          return;
        }
        if (event.state === 'completed') {
          showContextMenu(menu.clientX, menu.clientY, [
            {
              label: 'Delete event',
              danger: true,
              run: () => {
                const index = this.events.findIndex((candidate) => candidate.id === event.id && candidate.kind === 'approval');
                if (index >= 0) {
                  this.events.splice(index, 1);
                  this.renderEvents();
                }
              },
            },
          ]);
        }
      });
      if (event.kind === 'patch') {
        let hint = 'Open the read-only review of the resolved patch.';
        if (event.state === 'pending') {
          hint = event.conflicted ?
            'Open the review of the conflicting patch. Hold CTRL to open it in its own tab.' :
            'Open the review of the patch. Hold CTRL to open it in its own tab.';
        }
        row.title = hint;
        row.addEventListener('click', (click) => {
          if (typeof event.id === 'number') {
            this.deps.openPatch(event.id, click.ctrlKey);
          }
        });
      }
      this.eventList.append(row);
    }
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'rail-empty';
      empty.textContent =
        this.filter === 'pending' ? 'No event waits for review.' : this.filter === 'completed' ? 'No completed events yet.' : 'No events to review.';
      this.eventList.append(empty);
    }
    const pendingCount = merged.filter((event) => event.state === 'pending').length;
    this.eventCount.textContent = pendingCount === 1 ? '1 pending' : `${pendingCount} pending`;
  }

  /**
   * Loads the entries of one folder into its container and wires the folder rows.
   *
   * @param container The element that holds the rows of one directory level.
   * @param directory The absolute path of the directory.
   * @param depth The tree depth of the rows, for the indent.
   */
  private async mountFolder(container: HTMLElement, directory: string, depth: number): Promise<void> {
    const names = await listDirectoryNames(directory);
    if (!names) {
      const note = document.createElement('p');
      note.className = 'rail-empty';
      note.textContent = 'The folder cannot be read.';
      container.append(note);
      return;
    }
    const entries: { name: string; directory: boolean }[] = [];
    for (const name of names) {
      const stat = await statPath(joinPath(directory, name));
      entries.push({ name, directory: stat?.directory ?? false });
    }
    entries.sort((left, right) =>
      left.directory === right.directory ? left.name.localeCompare(right.name) : left.directory ? -1 : 1,
    );
    for (const entry of entries) {
      container.append(this.buildTreeRow(directory, entry, depth));
    }
  }

  /** Builds one tree row: a lazy folder with its twisty, or a plain file line. */
  private buildTreeRow(directory: string, entry: { name: string; directory: boolean }, depth: number): HTMLElement {
    const row = document.createElement('div');
    row.className = `rail-tree-row${entry.directory ? ' folder' : ''}`;
    row.style.setProperty('--d', String(depth));
    const twisty = document.createElement('span');
    twisty.className = 'rail-twisty';
    twisty.textContent = entry.directory ? '▸' : '';
    const icon = document.createElement('span');
    icon.className = `rail-file-icon ${fileIconClass(entry.name, entry.directory)}`;
    const label = document.createElement('span');
    label.textContent = entry.name;
    row.append(twisty, icon, label);
    if (!entry.directory) {
      return row;
    }
    const children = document.createElement('div');
    children.className = 'rail-tree-children';
    children.hidden = true;
    const folder: TreeFolder = { children, loaded: false, open: false };
    this.folders.set(row, folder);
    row.addEventListener('click', () => {
      folder.open = !folder.open;
      children.hidden = !folder.open;
      twisty.textContent = folder.open ? '▾' : '▸';
      if (folder.open && !folder.loaded) {
        folder.loaded = true;
        void this.mountFolder(children, joinPath(directory, entry.name), depth + 1);
      }
    });
    const wrap = document.createElement('div');
    wrap.append(row, children);
    return wrap;
  }
}
