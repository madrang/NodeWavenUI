/**
 * The drag handles that resize the rail and the chat columns. Each width clamps between its
 * bounds and persists in the local storage of the window, so the columns keep their widths across
 * window restarts. Pointer capture keeps a drag alive over the embedded guests of the workspace.
 */

import { requireElement } from './dom.js';

/** One column the user resizes: its elements, its bounds, and its storage key. */
interface ResizableColumn {
  /** The drag handle of the column. */
  readonly handle: string;
  /** The column element. */
  readonly column: string;
  /** The local storage key of the width. */
  readonly storageKey: string;
  /** The width bounds and the default, in pixels. */
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  /** True when the column anchors at the left window edge, so the pointer reads the width from
   * its left border. The chat column anchors at the right edge and reads from its right border. */
  readonly anchoredLeft: boolean;
}

/** The resizable columns of the workspace, in layout order. */
const COLUMNS: readonly ResizableColumn[] = [
  {
    handle: '#rail-resizer',
    column: '#rail-left',
    storageKey: 'rail-column-width',
    min: 200,
    max: 480,
    fallback: 300,
    anchoredLeft: true,
  },
  {
    handle: '#chat-resizer',
    column: '#chat-column',
    storageKey: 'chat-column-width',
    min: 320,
    max: 760,
    fallback: 400,
    anchoredLeft: false,
  },
];

/** Reads the stored width of one column, or its default when none sits within the bounds. */
function storedWidth(column: ResizableColumn): number {
  const value = Number(window.localStorage.getItem(column.storageKey));
  return value >= column.min && value <= column.max ? value : column.fallback;
}

/** Clamps one width into the bounds of one column. */
function clampWidth(column: ResizableColumn, width: number): number {
  return Math.min(column.max, Math.max(column.min, width));
}

/** Applies the stored widths and wires the drag handles of the resizable columns. */
export function installColumnResizers(): void {
  for (const spec of COLUMNS) {
    const handle = requireElement<HTMLDivElement>(spec.handle);
    const column = requireElement<HTMLElement>(spec.column);
    column.style.width = `${storedWidth(spec)}px`;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing-column');
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return;
      }
      const bounds = column.getBoundingClientRect();
      const width = spec.anchoredLeft ? event.clientX - bounds.left : bounds.right - event.clientX;
      column.style.width = `${clampWidth(spec, width)}px`;
    });
    const end = (event: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return;
      }
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-column');
      window.localStorage.setItem(spec.storageKey, column.style.width);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
