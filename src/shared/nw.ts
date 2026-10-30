/**
 * NW.js additions to the standard web APIs.
 * NW.js does not ship type declarations for these additions, so this file declares them.
 */

/**
 * A File object as produced by an NW.js file input.
 * NW.js adds the absolute filesystem path of the selection, which a plain browser does not provide.
 */
export interface NwFile extends File {
  readonly path: string;
}

/**
 * Reads the absolute filesystem path from a file selected through an NW.js file input.
 *
 * @param file The file object to read.
 * @returns The absolute path, or null when the file object did not come from NW.js.
 */
export function getNwFilePath(file: File): string | null {
  const path = (file as NwFile).path;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/** The NW.js window API surface this app uses. */
interface NwWindow {
  resizeTo: (width: number, height: number) => void;
  setResizable: (resizable: boolean) => void;
  close: (force?: boolean) => void;
  minimize?: () => void;
  moveTo?: (x: number, y: number) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  /** Sets the size limit for user resizing. The SDK build provides the method. */
  readonly setMinimumSize?: (width: number, height: number) => void;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

/** The placement of the app window, as the NW.js wrapper reports it. */
export interface WindowPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Reads the NW.js window wrapper.
 *
 * @returns The wrapper, or null outside NW.js or before the NW extension initializes the window.
 */
function readNwWindow(): NwWindow | null {
  const nw = (globalThis as { nw?: { Window?: { get?: unknown } } }).nw;
  const getWindow = nw?.Window?.get;
  if (typeof getWindow !== 'function') {
    return null;
  }
  let candidate: unknown;
  try {
    candidate = (getWindow as () => unknown)();
  } catch (error) {
    // nw.Window.get throws while the NW extension initializes the window. A later call retries.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the NW window wrapper could not be read: ${message}`);
    return null;
  }
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (
    typeof record.resizeTo !== 'function' ||
    typeof record.setResizable !== 'function' ||
    typeof record.close !== 'function'
  ) {
    return null;
  }
  return record as unknown as NwWindow;
}

/**
 * Resizes the app window and locks user resizing again.
 * A transparent NW.js window ignores resizeTo while it is not resizable, so the resize briefly unlocks the window.
 * NW.js documents resizeTo as an inner-size operation.
 * The call does nothing outside NW.js, so a page in a plain browser keeps its size.
 *
 * @param width The new inner width in pixels.
 * @param height The new inner height in pixels.
 */
export function resizeWindowLocked(width: number, height: number): void {
  const appWindow = readNwWindow();
  if (appWindow === null) {
    return;
  }
  appWindow.setResizable(true);
  appWindow.resizeTo(width, height);
  appWindow.setResizable(false);
}

/** The minimum inner size of the user-resizable main app window, in pixels. */
export const MINIMUM_MAIN_WINDOW_SIZE = { width: 200, height: 200 } as const;

/**
 * Resizes the app window and leaves it user-resizable.
 * The main app is the only screen the user can resize, and it never drops below the minimum size.
 * The call does nothing outside NW.js.
 *
 * @param width The new inner width in pixels, at least the minimum width.
 * @param height The new inner height in pixels, at least the minimum height.
 */
export function resizeWindowResizable(width: number, height: number): void {
  const appWindow = readNwWindow();
  if (appWindow === null) {
    return;
  }
  appWindow.setResizable(true);
  appWindow.resizeTo(Math.max(width, MINIMUM_MAIN_WINDOW_SIZE.width), Math.max(height, MINIMUM_MAIN_WINDOW_SIZE.height));
  // The minimum size lands after the resize. Size hints set while the window is not resizable lock the window
  // and the resize that follows gets eaten.
  appWindow.setMinimumSize?.(MINIMUM_MAIN_WINDOW_SIZE.width, MINIMUM_MAIN_WINDOW_SIZE.height);
}

/**
 * Closes the app window.
 * The call does nothing outside NW.js.
 */
export function closeWindow(): void {
  readNwWindow()?.close();
}

/**
 * Closes the app window without the close event, so a registered close handler cannot run again.
 * The shutdown path uses it after the child windows closed.
 */
export function forceCloseWindow(): void {
  readNwWindow()?.close(true);
}

/**
 * Minimizes the app window.
 * The call does nothing outside NW.js.
 */
export function minimizeWindow(): void {
  readNwWindow()?.minimize?.();
}

/**
 * Reads the current placement of the app window.
 *
 * @returns The placement, or null outside NW.js or when the wrapper hides the values.
 */
export function readWindowPlacement(): WindowPlacement | null {
  const appWindow = readNwWindow();
  const x = appWindow?.x;
  const y = appWindow?.y;
  const width = appWindow?.width;
  const height = appWindow?.height;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Moves the app window to an outer position.
 * The call does nothing outside NW.js.
 *
 * @param x The distance from the left edge of the screen, in pixels.
 * @param y The distance from the top edge of the screen, in pixels.
 */
export function moveWindow(x: number, y: number): void {
  readNwWindow()?.moveTo?.(x, y);
}

/**
 * Subscribes to a window event of the NW.js wrapper, for example "move" and "resize".
 * The `on` call stays attached to the wrapper: a detached call loses `this`, and the NW.js event binding throws.
 *
 * @param event The event name.
 * @param listener The listener the event calls.
 * @returns True when the subscription landed.
 */
export function onWindowEvent(event: string, listener: () => void): boolean {
  const appWindow = readNwWindow();
  const on = appWindow?.on;
  if (appWindow === null || typeof on !== 'function') {
    return false;
  }
  on.call(appWindow, event, listener);
  return true;
}

/** An NW.js window wrapper for a child window that this app opens. */
export interface NwChildWindow {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  close: () => void;
  /** Opens the DevTools window of this child. The SDK build provides the method. */
  readonly showDevTools?: () => void;
  /** Runs a script in the child window. A null frame selects the whole window. */
  eval: (iframe: HTMLIFrameElement | null, script: string) => void;
  /** The DOM window of the child, present after the child loads. */
  readonly window?: Window;
}

/** The size and chrome options a child window accepts. */
export interface ChildWindowOpenOptions {
  readonly width: number;
  readonly height: number;
  readonly frame?: boolean;
  readonly transparent?: boolean;
}

/**
 * Reads the current window wrapper in the child-window shape, for exposing the main window.
 *
 * @returns The wrapper with the page DOM window attached, or null outside NW.js.
 */
export function readMainWindowAsChild(): NwChildWindow | null {
  const nw = (globalThis as { nw?: { Window?: { get?: unknown } } }).nw;
  const getWindow = nw?.Window?.get;
  if (typeof getWindow !== 'function') {
    return null;
  }
  let candidate: unknown;
  try {
    candidate = (getWindow as () => unknown)();
  } catch {
    return null;
  }
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (
    typeof record.close !== 'function' ||
    typeof record.on !== 'function' ||
    typeof record.eval !== 'function'
  ) {
    return null;
  }
  const handle = candidate as unknown as NwChildWindow;
  // Explicit bound adapters: a spread drops prototype methods, and a detached call loses its receiver.
  const adapter: NwChildWindow = {
    on: handle.on.bind(candidate),
    close: handle.close.bind(candidate),
    eval: handle.eval.bind(candidate),
    ...(typeof record.showDevTools === 'function'
      ? { showDevTools: (record.showDevTools as () => void).bind(candidate) }
      : {}),
    window,
  };
  return adapter;
}

/**
 * Opens a child window through the NW.js window API.
 *
 * @param url The address the child loads.
 * @param options The size and frame options of the child window.
 * @returns The window wrapper, or null outside NW.js or when the open call is missing.
 */
export function openChildWindow(url: string, options: ChildWindowOpenOptions): Promise<NwChildWindow | null> {
  const nw = (globalThis as { nw?: { Window?: { open?: unknown } } }).nw;
  const open = nw?.Window?.open;
  if (typeof open !== 'function') {
    return Promise.resolve(null);
  }
  const openOptions: Record<string, unknown> = { width: options.width, height: options.height };
  if (options.frame !== undefined) {
    openOptions.frame = options.frame;
  }
  if (options.transparent !== undefined) {
    openOptions.transparent = options.transparent;
  }
  return new Promise((resolve) => {
    (open as (target: string, opts: Record<string, unknown>, callback: (win: unknown) => void) => void)(
      url,
      openOptions,
      (candidate: unknown) => {
        if (typeof candidate !== 'object' || candidate === null) {
          resolve(null);
          return;
        }
        const record = candidate as Record<string, unknown>;
        if (
          typeof record.close !== 'function' ||
          typeof record.on !== 'function' ||
          typeof record.eval !== 'function'
        ) {
          resolve(null);
          return;
        }
        resolve(candidate as unknown as NwChildWindow);
      },
    );
  });
}
