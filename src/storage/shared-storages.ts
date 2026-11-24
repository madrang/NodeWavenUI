/**
 * The persisted storage sharing record of one workspace: which storages the chat agent may read.
 * The settings store reads and writes the record, so it lives with the storage layer, reachable
 * from the worker core and from the renderers. The registry that opens the shared storages sits
 * beside this file (`src/storage/share-registry.ts`).
 */

/** The access one shared storage grants the chat agent. */
export type StorageAccess = 'none' | 'readonly';

/** One shared storage entry of the persisted record. */
export interface SharedStorageEntry {
  readonly id: string;
  readonly setupId: string;
  readonly label: string;
  /** The URI id of the storage, the sanitized label. It stays unique among the shared storages. */
  readonly uriId: string;
  readonly config: unknown;
  readonly password: string | null;
  readonly access: StorageAccess;
}

/** The persisted sharing record of the workspace. */
export interface SharedStoragesRecord {
  /** The access to the workspace settings storage itself. Not shared by default. */
  readonly settingsAccess: StorageAccess;
  readonly storages: readonly SharedStorageEntry[];
}

/** The empty sharing record: nothing shared. */
export const EMPTY_SHARED_STORAGES: SharedStoragesRecord = { settingsAccess: 'none', storages: [] };

function isAccess(value: unknown): value is StorageAccess {
  return value === 'none' || value === 'readonly';
}

/**
 * Checks that a value is a valid SharedStoragesRecord.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value satisfies the record shape.
 */
export function isSharedStoragesRecord(value: unknown): value is SharedStoragesRecord {
  if (typeof value !== 'object' || !value) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isAccess(candidate.settingsAccess) || !Array.isArray(candidate.storages)) {
    return false;
  }
  return candidate.storages.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === 'string' &&
      typeof (entry as Record<string, unknown>).setupId === 'string' &&
      typeof (entry as Record<string, unknown>).label === 'string' &&
      typeof (entry as Record<string, unknown>).uriId === 'string' &&
      ((entry as Record<string, unknown>).password === null ||
        typeof (entry as Record<string, unknown>).password === 'string') &&
      isAccess((entry as Record<string, unknown>).access),
  );
}
