/**
 * The window operations of the renderer pages, served by the main process over the
 * `nodewavenui` bridge. Every call names the window of the calling page.
 */

import { readBridge, type BridgeWindowPlacement } from '../shared/bridge.js';

/** Reads the bridge, or null outside an app window. */
function bridge() {
  return readBridge();
}

/**
 * Resizes the window to one content size and locks resizing at it.
 *
 * @param width The content width.
 * @param height The content height.
 */
export async function resizeWindowLocked(width: number, height: number): Promise<void> {
  await bridge()?.windows.resizeLocked(width, height);
}

/**
 * Resizes the window to one content size and leaves it resizable with a 200 by 200 minimum.
 *
 * @param width The content width.
 * @param height The content height.
 */
export async function resizeWindowResizable(width: number, height: number): Promise<void> {
  await bridge()?.windows.resizeResizable(width, height);
}

/** Closes the window through its close event, so a drain can still run. */
export async function closeWindow(): Promise<void> {
  await bridge()?.windows.close();
}

/** Closes the window at once, past every close event. */
export async function forceCloseWindow(): Promise<void> {
  await bridge()?.windows.forceClose();
}

/** Minimizes the window. */
export async function minimizeWindow(): Promise<void> {
  await bridge()?.windows.minimize();
}

/**
 * Reads the placement of the window.
 *
 * @returns The placement, or null outside an app window.
 */
export async function readWindowPlacement(): Promise<BridgeWindowPlacement | null> {
  return (await bridge()?.windows.placement()) ?? null;
}

/**
 * Applies one outer placement of the window: position and size in one call.
 *
 * @param x The x position.
 * @param y The y position.
 * @param width The outer width.
 * @param height The outer height.
 */
export async function setWindowBounds(x: number, y: number, width: number, height: number): Promise<void> {
  await bridge()?.windows.setBounds(x, y, width, height);
}

/**
 * Moves the window.
 *
 * @param x The x position.
 * @param y The y position.
 */
export async function moveWindow(x: number, y: number): Promise<void> {
  await bridge()?.windows.move(x, y);
}

/**
 * Subscribes to one window event.
 *
 * @param event The event: `close`, `moved`, or `resized`.
 * @param listener The listener the event calls.
 * @returns The unsubscribe function, or a no-op outside an app window.
 */
export function onWindowEvent(event: 'close' | 'moved' | 'resized', listener: () => void): () => void {
  const windows = bridge()?.windows;
  if (!windows) {
    return () => {};
  }
  return windows.on(event, listener);
}
