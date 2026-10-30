/**
 * Copies every stored value from one storage backend into another.
 * The IndexedDB workspace storage moves into the JSON file storage this way: the source decrypts its records,
 * and the target stores them under its own protection. Reserved keys of a source stay hidden, because `keys` hides them.
 */

import { StorageError, type StorageBackend } from './storage.js';

/** What one copy run moved. */
export interface StorageCopyReport {
  /** The keys that now hold a value in the target. */
  readonly copiedKeys: readonly string[];
}

/**
 * Copies every key and value of one backend into another.
 * A key the source lacks stays untouched in the target. Values overwrite target values.
 *
 * @param source The backend to read.
 * @param target The backend to write.
 * @returns The keys the copy wrote.
 * @throws StorageError when either backend fails.
 */
export async function copyStorageValues(source: StorageBackend, target: StorageBackend): Promise<StorageCopyReport> {
  const keys = await source.keys();
  const copiedKeys: string[] = [];
  for (const key of keys) {
    const value = await source.get(key);
    if (value === null) {
      continue;
    }
    await target.set(key, value);
    copiedKeys.push(key);
  }
  return { copiedKeys };
}
