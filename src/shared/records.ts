/**
 * Record guards for untyped values that cross a module boundary, shared by every compile context.
 */

/**
 * Checks that a value is a record.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads a value as a record.
 *
 * @param value The value to read. It can have any type.
 * @returns The record, or null when the value is not a non-null object.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
