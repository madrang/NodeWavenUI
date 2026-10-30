/**
 * The remembered geometry of the main app window.
 * The window remembers its outer position and its size across sessions, in the local storage of the window.
 * The launcher centers through the manifest `position` option instead, so only the main app carries a placement.
 */

import { moveWindow, onWindowEvent, readWindowPlacement, resizeWindowResizable } from '../shared/nw.js';

const GEOMETRY_STORAGE_KEY = 'main-window-geometry';
const SAVE_DELAY_MILLISECONDS = 500;

/** The remembered placement of the main app window. */
interface WindowGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

let tracking = false;
let saveTimer: number | undefined;

/**
 * Checks that a value is a sane remembered placement.
 * The bounds keep a stale entry from placing the window far off a current screen.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries four numbers within the sane ranges.
 */
function isWindowGeometry(value: unknown): value is WindowGeometry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const { x, y, width, height } = candidate;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return false;
  }
  const sizeSane = width >= 200 && width <= 10000 && height >= 200 && height <= 10000;
  const positionSane = x >= -10000 && x <= 30000 && y >= -10000 && y <= 30000;
  return sizeSane && positionSane;
}

/** Stores one placement. */
function saveGeometry(geometry: WindowGeometry): void {
  window.localStorage.setItem(GEOMETRY_STORAGE_KEY, JSON.stringify(geometry));
}

/** Reads the placement once the user stops dragging, then stores it. */
const scheduleSave = (): void => {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const placement = readWindowPlacement();
    if (placement !== null) {
      saveGeometry(placement);
    }
  }, SAVE_DELAY_MILLISECONDS);
};

/**
 * Restores the remembered geometry of the main app window.
 *
 * @returns True when a remembered placement was applied.
 */
export function restoreMainWindowGeometry(): boolean {
  const stored = window.localStorage.getItem(GEOMETRY_STORAGE_KEY);
  if (stored === null) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }
  if (!isWindowGeometry(parsed)) {
    return false;
  }
  resizeWindowResizable(parsed.width, parsed.height);
  moveWindow(parsed.x, parsed.y);
  return true;
}

/**
 * Starts remembering the geometry of the main app window.
 * The call is safe to repeat: only the first call subscribes.
 */
export function rememberMainWindowGeometry(): void {
  if (tracking) {
    return;
  }
  tracking = true;
  onWindowEvent('move', scheduleSave);
  onWindowEvent('resize', scheduleSave);
}
