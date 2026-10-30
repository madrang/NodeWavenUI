/**
 * Storage backend on IndexedDB.
 * The data lives in the browser profile of the NW.js renderer, under the origin of the app window.
 * The origin of an NW.js app is its chrome-extension id, and that id has changed across NW.js releases (nw.js issue 7778), so pin the user data directory before this backend becomes the durable home of settings.
 */

import { StorageError, type StorageBackend } from './storage.js';

/** Configuration for the IndexedDB backend. */
export interface IndexedDbStorageConfig {
  /** Identifier of this backend instance. The default is "indexeddb". */
  readonly id?: string;
  /** Database name. The default is "nodewavenui". */
  readonly databaseName?: string;
  /** Object store name inside the database. The default is "kv". */
  readonly storeName?: string;
}

/**
 * Resolves one IndexedDB request into a promise.
 *
 * @param request The request to await.
 * @returns The result of the request.
 */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('The IndexedDB request failed without an error object.'));
    };
  });
}

/** Stores string values in an IndexedDB object store. */
export class IndexedDbStorage implements StorageBackend {
  readonly id: string;
  private readonly databaseName: string;
  private readonly storeName: string;
  private connection: Promise<IDBDatabase> | null = null;

  /**
   * @param config The identifiers of the database and the store.
   */
  constructor(config: IndexedDbStorageConfig = {}) {
    this.id = config.id ?? 'indexeddb';
    this.databaseName = config.databaseName ?? 'nodewavenui';
    this.storeName = config.storeName ?? 'kv';
  }

  /**
   * Reads one value.
   *
   * @param key The key to read.
   * @returns The stored value, or null when the key holds no value.
   * @throws StorageError when the database or the transaction fails.
   */
  async get(key: string): Promise<string | null> {
    const database = await this.connect();
    const value = await this.run(database, 'readonly', (store) => requestToPromise(store.get(key)));
    return typeof value === 'string' ? value : null;
  }

  /**
   * Writes one value.
   *
   * @param key The key to write.
   * @param value The value to store.
   * @throws StorageError when the database or the transaction fails.
   */
  async set(key: string, value: string): Promise<void> {
    const database = await this.connect();
    await this.run(database, 'readwrite', (store) => requestToPromise(store.put(value, key)));
  }

  /**
   * Removes one value.
   *
   * @param key The key to remove.
   * @throws StorageError when the database or the transaction fails.
   */
  async delete(key: string): Promise<void> {
    const database = await this.connect();
    await this.run(database, 'readwrite', (store) => requestToPromise(store.delete(key)));
  }

  /**
   * Lists every key that holds a value.
   *
   * @returns The keys of the store.
   * @throws StorageError when the database or the transaction fails.
   */
  async keys(): Promise<readonly string[]> {
    const database = await this.connect();
    const keys = await this.run(database, 'readonly', (store) => requestToPromise(store.getAllKeys()));
    return keys.filter((key): key is string => typeof key === 'string');
  }

  private connect(): Promise<IDBDatabase> {
    if (this.connection === null) {
      this.connection = this.open();
    }
    return this.connection;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        // The store uses out-of-line keys, so the key type stays a plain string.
        request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(
          new StorageError(`Could not open the IndexedDB database "${this.databaseName}".`, {
            cause: request.error,
          }),
        );
      };
    });
  }

  private async run<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const transaction = database.transaction(this.storeName, mode);
    try {
      return await action(transaction.objectStore(this.storeName));
    } catch (error) {
      throw new StorageError(`The IndexedDB store "${this.storeName}" failed.`, { cause: error });
    }
  }
}
