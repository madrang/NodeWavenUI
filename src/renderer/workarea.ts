/**
 * The view manager of the center workspace: the tab strip above the views. The settings pane and
 * every embedded frame register as views. The active view fills the workspace, every tab carries
 * its close, and the placeholder shows while no view stays open.
 */

import { requireElement } from './dom.js';

/** One view of the center workspace. */
export interface WorkareaView {
  /** The tab label. */
  readonly label: string;
  /** The kind badge before the label, for example the frame kind. */
  readonly badge?: string;
  /** The tooltip of the tab. */
  readonly title?: string;
  /** The element the view shows. The manager flips only its visibility, it moves nothing. */
  readonly content: HTMLElement;
  /** Builds extra controls between the tab and its close, for example a share switch. */
  readonly actions?: (group: HTMLElement) => void;
  /** Runs when the tab close fires. The owner unregisters the view in answer. */
  readonly onClose: () => void;
}

/** One registered view with its tab group. */
interface WorkareaEntry {
  readonly view: WorkareaView;
  readonly group: HTMLSpanElement;
  readonly label: HTMLSpanElement;
}

/** Owns the tab strip and the view visibility of the center workspace. */
export class Workarea {
  private readonly strip: HTMLElement;
  private readonly center: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly entries = new Map<string, WorkareaEntry>();
  private activeId: string | null = null;

  constructor() {
    this.strip = requireElement<HTMLElement>('#workarea-tabs');
    this.center = requireElement<HTMLElement>('#frames-center');
    this.placeholder = requireElement<HTMLElement>('#workarea-empty');
  }

  /**
   * Registers one view and activates it. A view that already exists only activates again.
   *
   * @param id The stable view id.
   * @param view The view facts.
   */
  register(id: string, view: WorkareaView): void {
    if (this.entries.has(id)) {
      this.activate(id);
      return;
    }
    const group = document.createElement('span');
    group.className = 'tab-group';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    if (view.badge) {
      const badge = document.createElement('span');
      badge.className = 'workarea-badge';
      badge.textContent = view.badge;
      tab.append(badge);
    }
    const label = document.createElement('span');
    label.textContent = view.label;
    tab.append(label);
    if (view.title) {
      tab.title = view.title;
    }
    tab.addEventListener('click', () => {
      this.activate(id);
    });
    view.actions?.(group);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.title = `Close ${view.label}`;
    close.textContent = '×';
    close.addEventListener('click', () => {
      view.onClose();
    });
    group.append(tab, close);
    this.strip.append(group);
    // A dynamic view arrives detached; the manager mounts it. The settings pane already sits in
    // the column and stays where it is.
    if (!view.content.isConnected) {
      this.center.append(view.content);
    }
    this.entries.set(id, { view, group, label });
    this.activate(id);
  }

  /** Removes one view. The last remaining tab takes over when the view was active. */
  unregister(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.entries.delete(id);
    entry.group.remove();
    entry.view.content.hidden = true;
    if (this.activeId === id) {
      this.activate([...this.entries.keys()].at(-1) ?? '');
    }
  }

  /** Activates one view: its tab reads active and its content fills the workspace. */
  activate(id: string): void {
    this.activeId = this.entries.has(id) ? id : null;
    for (const [key, entry] of this.entries) {
      entry.group.classList.toggle('active', key === this.activeId);
      entry.view.content.hidden = key !== this.activeId;
    }
    const any = this.entries.size > 0;
    this.strip.hidden = !any;
    this.placeholder.hidden = any;
  }

  /** Rewrites the label of one view tab, for example after a frame navigation. */
  setLabel(id: string, label: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.label.textContent = label;
    }
  }
}

/** The shared workarea of the workspace page. */
let workarea: Workarea | null = null;

/** Reads the shared workarea, creating it on the first call. */
export function getWorkarea(): Workarea {
  if (!workarea) {
    workarea = new Workarea();
  }
  return workarea;
}
