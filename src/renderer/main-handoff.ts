/**
 * The handoff contract between the launcher window and the workspace window.
 * The launcher opens main.html and delivers one payload through the receiver global the workspace
 * window exposes. The payload stays in memory: it carries the workspace password, so it never
 * lands in a URL or in storage.
 */

import type { FrameModeId } from './frame-mode.js';
import { isKnownFrameMode } from './frame-mode.js';
import {
  isWorkspaceDirectory,
  isWorkspaceSettings,
  type WorkspaceDirectory,
  type WorkspaceSettings,
} from '../shared/workspace.js';

/** The startup data the workspace window needs. */
export interface MainHandoffPayload {
  readonly directory: WorkspaceDirectory;
  readonly settings: WorkspaceSettings;
  /** The workspace password. Null when the storage setup needs none. */
  readonly password: string | null;
  readonly frameMode: FrameModeId;
}

/** The callbacks the workspace window answers the handoff with. */
export interface MainHandoffCallbacks {
  /** The workspace window finished its startup. The launcher may close itself. */
  onReady(): void;
  /** The workspace window failed its startup. The message explains the failure. */
  onFailed(message: string): void;
}

/** The receiver the workspace window exposes on its global object after its module loaded. */
export type MainHandoffReceiver = (payload: unknown, callbacks: MainHandoffCallbacks) => void;

/** The property name of the receiver on the global object of the workspace window. */
export const MAIN_HANDOFF_RECEIVER_NAME = '__nodewavenReceiveMainHandoff';

/**
 * Checks that a value is a valid MainHandoffPayload.
 * The payload crosses a window boundary, so the receiver validates it before use.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the workspace directory, the settings, the password, and a frame mode.
 */
export function isMainHandoffPayload(value: unknown): value is MainHandoffPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isWorkspaceDirectory(candidate.directory) &&
    isWorkspaceSettings(candidate.settings) &&
    (candidate.password === null || typeof candidate.password === 'string') &&
    isKnownFrameMode(candidate.frameMode)
  );
}
