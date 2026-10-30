/**
 * The window frame registry of the workspace window.
 * NW.js fixes the frame at window creation, so the launcher reads the stored mode before it opens
 * the workspace window. The workspace settings store holds the chosen mode id, and an absent or
 * unknown id falls back to "system". A new workspace holds no record, so it opens with the system
 * border.
 */

/** The id of one registered frame mode. */
export type FrameModeId = 'system' | 'borderless';

/** One registered frame mode. */
export interface FrameModeDefinition {
  readonly id: FrameModeId;
  readonly label: string;
}

/** Every registered frame mode, in settings order. */
export const FRAME_MODES: readonly FrameModeDefinition[] = [
  { id: 'system', label: 'System border' },
  { id: 'borderless', label: 'Borderless' },
];

/** The frame mode the app uses when the settings store holds no mode or an unknown one. */
export const DEFAULT_FRAME_MODE: FrameModeId = 'system';

/**
 * Checks that a value names a registered frame mode.
 *
 * @param value The value to check. It can have any type.
 * @returns True when a mode carries the id.
 */
export function isKnownFrameMode(value: unknown): value is FrameModeId {
  return typeof value === 'string' && FRAME_MODES.some((mode) => mode.id === value);
}

/**
 * Resolves a stored value into a frame mode id, with the default applied.
 *
 * @param stored The stored value from the workspace settings, or null.
 * @returns The frame mode id, "system" when the stored value is absent or unknown.
 */
export function resolveFrameMode(stored: string | null): FrameModeId {
  return isKnownFrameMode(stored) ? stored : DEFAULT_FRAME_MODE;
}
