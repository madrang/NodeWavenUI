/**
 * The drag handle that resizes the chat column. The width clamps between its bounds and persists
 * in the local storage of the window, so the column keeps its width across window restarts.
 * Pointer capture keeps the drag alive over the frame guests that flank the layout.
 */

import { requireElement } from './dom.js';

/** The local storage key of the chat column width. */
const STORAGE_KEY = 'chat-column-width';

/** The width bounds of the chat column, in pixels. */
const MIN_WIDTH = 320;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 400;

/** Reads the stored width, or the default when none sits within the bounds. */
function storedWidth(): number {
  const value = Number(window.localStorage.getItem(STORAGE_KEY));
  return value >= MIN_WIDTH && value <= MAX_WIDTH ? value : DEFAULT_WIDTH;
}

/** Clamps one width into the bounds. */
function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

/** Applies the stored width and wires the drag handle of the chat column. */
export function installChatResizer(): void {
  const handle = requireElement<HTMLDivElement>('#chat-resizer');
  const column = requireElement<HTMLElement>('#chat-column');
  column.style.width = `${storedWidth()}px`;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing-chat');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) {
      return;
    }
    const bounds = column.getBoundingClientRect();
    column.style.width = `${clampWidth(bounds.right - event.clientX)}px`;
  });
  const end = (event: PointerEvent): void => {
    if (!handle.hasPointerCapture(event.pointerId)) {
      return;
    }
    handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-chat');
    window.localStorage.setItem(STORAGE_KEY, column.style.width);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
