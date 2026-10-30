/**
 * The storage sharing of one workspace: which storages the chat agent may read.
 * The settings storage stays unshared by default. Every added storage carries its own access level,
 * none or read-only, set in the settings section. The record persists in the `shared-storages` record.
 */

import type { StorageSetup } from '../plugins.js';
import type { StorageBackend } from '../storage/storage.js';

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
  if (typeof value !== 'object' || value === null) {
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

/** The public state of one shared storage, for the settings cards. */
export interface SharedStorageState {
  readonly id: string;
  readonly label: string;
  readonly uriId: string;
  readonly setupId: string;
  readonly access: StorageAccess;
  readonly open: boolean;
  readonly error: string | null;
}

interface OpenEntry {
  readonly entry: SharedStorageEntry;
  backend: StorageBackend | null;
  error: string | null;
}

/** Owns the shared storages of the workspace and answers the read tool. */
export class StorageShareRegistry {
  private settingsAccess: StorageAccess = 'none';
  private readonly opened = new Map<string, OpenEntry>();

  constructor(
    private readonly settingsBackend: StorageBackend,
    private readonly resolveSetup: (setupId: string) => StorageSetup | undefined,
    private readonly directoryPath: string,
  ) {}

  /**
   * Applies one record: every entry opens, whatever its access level, so a later access change needs no reopen.
   *
   * @param record The persisted sharing record.
   */
  applyRecord(record: SharedStoragesRecord): void {
    this.settingsAccess = record.settingsAccess;
    const kept = new Set<string>();
    for (const entry of record.storages) {
      kept.add(entry.id);
      const existing = this.opened.get(entry.id);
      if (existing !== undefined) {
        if (existing.entry !== entry) {
          this.reopen(entry, existing);
        }
        continue;
      }
      const fresh: OpenEntry = { entry, backend: null, error: null };
      this.opened.set(entry.id, fresh);
      this.open(entry, fresh);
    }
    for (const id of [...this.opened.keys()]) {
      if (!kept.has(id)) {
        this.opened.delete(id);
      }
    }
  }

  private reopen(entry: SharedStorageEntry, open: OpenEntry): void {
    this.opened.set(entry.id, { entry, backend: null, error: null });
    this.open(entry, this.opened.get(entry.id) as OpenEntry);
  }

  private open(entry: SharedStorageEntry, open: OpenEntry): void {
    const setup = this.resolveSetup(entry.setupId);
    if (setup === undefined) {
      open.error = `The storage setup "${entry.setupId}" is not registered.`;
      return;
    }
    try {
      open.backend = setup.open({
        directoryPath: this.directoryPath,
        config: entry.config,
        ...(entry.password !== null ? { password: entry.password } : {}),
      });
      open.error = null;
    } catch (error) {
      open.backend = null;
      open.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** The states of the shared storages, in record order. */
  states(): readonly SharedStorageState[] {
    return [...this.opened.values()].map((open) => ({
      id: open.entry.id,
      label: open.entry.label,
      uriId: open.entry.uriId,
      setupId: open.entry.setupId,
      access: open.entry.access,
      open: open.backend !== null,
      error: open.error,
    }));
  }

  /** The current access to the settings storage. */
  get settingsSharedReadonly(): boolean {
    return this.settingsAccess === 'readonly';
  }

  /** The backend id of the settings storage, the uri id the read tool serves when it is shared. */
  get settingsBackendId(): string {
    return this.settingsBackend.id;
  }

  /** The storage ids the read tool serves, with the settings storage first when it is shared. */
  sharedIds(): readonly string[] {
    const ids: string[] = this.settingsSharedReadonly ? [this.settingsBackend.id] : [];
    for (const open of this.opened.values()) {
      if (open.entry.access === 'readonly') {
        ids.push(open.entry.uriId);
      }
    }
    return ids;
  }

  /**
   * Reads one record of one shared storage.
   *
   * @param storageId The uriId of the shared storage, or the backend id of the settings storage.
   * @param key The record key.
   * @returns The record value, or null when the record is empty.
   * @throws Error when the storage is not shared with the chat agent. The message names the shared ids.
   */
  async readKey(storageId: string, key: string): Promise<string | null> {
    if (this.settingsSharedReadonly && storageId === this.settingsBackend.id) {
      return this.settingsBackend.get(key);
    }
    for (const open of this.opened.values()) {
      if (open.entry.uriId === storageId) {
        if (open.entry.access !== 'readonly') {
          throw new Error(
            `The storage "${storageId}" is not shared with the chat agent. Flip its access to read-only in the settings.`,
          );
        }
        if (open.backend === null) {
          throw new Error(`The storage "${storageId}" did not open: ${open.error ?? 'unknown error'}`);
        }
        return open.backend.get(key);
      }
    }
    const shared = this.sharedIds();
    const list = shared.length > 0 ? shared.join(', ') : 'no storage is shared';
    throw new Error(
      `The storage "${storageId}" is not shared with the chat agent. Shared now: ${list}. The settings storage stays unshared by default.`,
    );
  }
}
