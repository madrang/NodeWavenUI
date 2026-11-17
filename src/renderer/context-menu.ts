/**
 * The reusable context menu of the workspace page: one floating list of actions at one pointer
 * position. Every surface that carries per-row actions opens it through the same call, so no
 * module builds its own menu. The menu closes on any outside press, on Escape, and on window
 * resize, and it clamps into the viewport.
 */

/** One action of the context menu. */
export interface ContextMenuItem {
  readonly label: string;
  /** The tooltip of the action. */
  readonly title?: string;
  /** True when the action removes something, so it reads with the error tint. */
  readonly danger?: boolean;
  readonly run: () => void;
}

/** The one open menu, with its dismissal wiring. */
interface OpenMenu {
  readonly root: HTMLDivElement;
  dismiss: (event: Event) => void;
}

let open: OpenMenu | null = null;

/** Closes the open menu, whichever surface opened it. */
export function closeContextMenu(): void {
  if (!open) {
    return;
  }
  window.removeEventListener('pointerdown', open.dismiss, true);
  window.removeEventListener('keydown', open.dismiss, true);
  window.removeEventListener('resize', closeContextMenu);
  open.root.remove();
  open = null;
}

/**
 * Opens the context menu at one position.
 *
 * @param x The viewport x of the pointer, from the contextmenu event.
 * @param y The viewport y of the pointer.
 * @param items The actions. An empty list opens nothing.
 */
export function showContextMenu(x: number, y: number, items: readonly ContextMenuItem[]): void {
  closeContextMenu();
  if (items.length === 0) {
    return;
  }
  const root = document.createElement('div');
  root.className = 'context-menu';
  for (const item of items) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = `context-menu-item${item.danger ? ' danger' : ''}`;
    action.textContent = item.label;
    if (item.title) {
      action.title = item.title;
    }
    action.addEventListener('click', () => {
      closeContextMenu();
      item.run();
    });
    root.append(action);
  }
  document.body.append(root);
  // The clamp reads the measured size, so it runs after the append.
  const left = Math.min(x, window.innerWidth - root.offsetWidth - 6);
  const top = Math.min(y, window.innerHeight - root.offsetHeight - 6);
  root.style.left = `${Math.max(6, left)}px`;
  root.style.top = `${Math.max(6, top)}px`;
  const dismiss = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== 'Escape') {
      return;
    }
    if (event.target instanceof Node && root.contains(event.target)) {
      return;
    }
    closeContextMenu();
  };
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('keydown', dismiss, true);
  window.addEventListener('resize', closeContextMenu);
  open = { root, dismiss };
}
