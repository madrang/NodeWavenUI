/**
 * The left rail of the workspace window: the approvals feed and the workspace file tree.
 * The feed lists the permission requests of the gate. A request waits as a pending row until the
 * approval card of its tab resolves it, then the row reads completed with its outcome. A pending
 * row click activates the tab that holds the card. The files panel lists the workspace directory
 * as a read-only tree with lazy folder expansion.
 */

import type { PermissionGate, PermissionRequestInfo } from './permission-gate.js';
import { requireElement } from './dom.js';
import { joinPath, listDirectoryNames, statPath } from './file-system.js';

/** The dependencies the rail works with. */
export interface RailDeps {
  /** The permission gate whose pending requests feed the events tab. Null before one exists. */
  readonly gate: PermissionGate | null;
  /** The absolute path of the workspace directory, the root of the files tree. */
  readonly workspacePath: string;
  /** Activates the tab that owns one pending request source. */
  readonly openTab: (source: string | null) => void;
}

/** One row of the approvals feed. */
interface RailEvent {
  readonly id: number;
  readonly title: string;
  readonly meta: string;
  readonly time: string;
  state: 'pending' | 'completed';
  outcome: 'approved' | 'denied' | 'resolved' | null;
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
  private readonly eventList: HTMLElement;
  private readonly eventCount: HTMLElement;
  private readonly fileTree: HTMLElement;
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
        this.showTab(name);
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
      this.renderEvents();
    });
    this.deps.gate?.subscribe(() => {
      this.syncPending();
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
      if (event.state === 'pending' && !live.has(event.id)) {
        // The request left the queue outside the rail, for example through a rule change.
        event.state = 'completed';
        event.outcome = 'resolved';
      }
    }
    for (const request of pending) {
      if (this.events.some((event) => event.id === request.id)) {
        continue;
      }
      this.events.unshift({
        id: request.id,
        title: eventTitleOf(request),
        meta: eventMetaOf(request),
        time: new Date().toLocaleTimeString(),
        state: 'pending',
        outcome: null,
      });
    }
    this.renderEvents();
  }

  /** Shows one rail tab and hides the other. */
  private showTab(name: string): void {
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

  /** Re-renders the approvals feed and the pending count. */
  private renderEvents(): void {
    this.eventList.replaceChildren();
    const visible = this.events.filter((event) =>
      this.filter === 'all' ? true : this.filter === 'pending' ? event.state === 'pending' : event.state === 'completed',
    );
    for (const event of visible) {
      const row = document.createElement('div');
      row.className = `rail-event ${event.state}${event.state === 'completed' && event.outcome === 'denied' ? ' denied' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'rail-event-dot';
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
      row.append(dot, body, time);
      if (event.state === 'pending') {
        row.title = 'Open the tab that holds the approval card.';
        row.addEventListener('click', () => {
          const request = this.deps.gate?.pendingRequests().find((candidate) => candidate.id === event.id);
          if (request) {
            this.deps.openTab(request.source);
          }
        });
      }
      this.eventList.append(row);
    }
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'rail-empty';
      empty.textContent =
        this.filter === 'pending' ? 'No approval waits.' : this.filter === 'completed' ? 'No approval completed yet.' : 'No approval activity.';
      this.eventList.append(empty);
    }
    const pendingCount = this.events.filter((event) => event.state === 'pending').length;
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
