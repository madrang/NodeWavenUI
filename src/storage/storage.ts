/**
 * The contract every storage backend plugin implements.
 * A backend stores string values under string keys, and every operation is asynchronous.
 * A backend decides the location (IndexedDB, a database, a file) and the protection (plain, encrypted).
 */

/** Error every storage backend throws on failure. */
export class StorageError extends Error {
  /**
   * @param message What failed, in a sentence a user can act on.
   * @param options The optional standard cause of this error.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** Stores string values under string keys. */
export interface StorageBackend {
  /** Stable identifier of this backend instance. */
  readonly id: string;

  /**
   * Reads one value.
   *
   * @param key The key to read.
   * @returns The stored value, or null when the key holds no value.
   * @throws StorageError when the backend fails.
   */
  get(key: string): Promise<string | null>;

  /**
   * Writes one value.
   *
   * @param key The key to write.
   * @param value The value to store.
   * @throws StorageError when the backend fails.
   */
  set(key: string, value: string): Promise<void>;

  /**
   * Removes one value.
   *
   * @param key The key to remove.
   * @throws StorageError when the backend fails.
   */
  delete(key: string): Promise<void>;

  /**
   * Lists every key that holds a value.
   *
   * @returns The keys, in no guaranteed order.
   * @throws StorageError when the backend fails.
   */
  keys(): Promise<readonly string[]>;
}

/**
 * Checks that a value satisfies the StorageBackend shape.
 * Use this guard at plugin registration, where modules arrive without type backing.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries an id string and the four methods as functions.
 */
export function isStorageBackend(value: unknown): value is StorageBackend {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.get === 'function' &&
    typeof candidate.set === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.keys === 'function'
  );
}
