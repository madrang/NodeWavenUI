/**
 * The storage sharing of one workspace: which storages the chat agent may read.
 * The settings storage stays unshared by default. Every added storage carries its own access level,
 * none or read-only, set in the settings section. The record persists in the `shared-storages` record.
 * The record shape and its guard live beside this file (`src/storage/shared-storages.ts`). The
 * registry stays platform free, so the settings pane of the workspace page and the chat engine of
 * the worker core each open the shared storages of their own context.
 */

import type { StorageBackend } from './storage.js';
import { GuardedStorage, type StoragePermissionCheck } from './guarded.js';
import { matchingRuleDecision, type PermissionRule } from '../shared/permissions.js';
import {
  type SharedStorageEntry,
  type SharedStoragesRecord,
  type StorageAccess,
} from './shared-storages.js';

export { EMPTY_SHARED_STORAGES, isSharedStoragesRecord } from './shared-storages.js';
export type { SharedStorageEntry, SharedStoragesRecord, StorageAccess } from './shared-storages.js';

/** The options one shared storage opens its backend with. */
export interface SharedStorageOpenOptions {
  readonly directoryPath: string;
  /** The non-secret configuration kept in the share record. */
  readonly config: unknown;
  /** The password, for setups that need one. */
  readonly password?: string;
}

/** The slice of a storage setup the registry opens a shared storage through. */
export interface SharedStorageSetupSource {
  /** Opens the backend for a workspace. */
  readonly open: (options: SharedStorageOpenOptions) => StorageBackend;
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

/** Builds the permission check of one shared storage: a rule that matches decides over the share,
 * and the share grant alone serves reads. A write without an allow rule refuses, because the
 * share record carries no write level. */
export function createShareGuardCheck(rules: () => readonly PermissionRule[]): StoragePermissionCheck {
  return {
    check: async (principal, action, target) => {
      const ruled = matchingRuleDecision(principal, action, target, rules());
      if (ruled === 'deny') {
        throw new Error(`A permission rule refuses the ${action} of the key "${target.key}".`);
      }
      if (!ruled && action === 'write') {
        throw new Error('The storage share grants reads only. A permission rule may grant the write.');
      }
    },
  };
}

/** Owns the shared storages of the workspace and answers the read tool. Every backend sits
 * behind the guarded storage wrapper: the share record grants the access level, and the
 * permission rules may still refuse a call that the share granted. */
export class StorageShareRegistry {
  private settingsAccess: StorageAccess = 'none';
  private readonly opened = new Map<string, OpenEntry>();
  private readonly guardedSettings: StorageBackend;

  constructor(
    private readonly settingsBackend: StorageBackend,
    private readonly resolveSetup: (setupId: string) => SharedStorageSetupSource | undefined,
    private readonly directoryPath: string,
    private readonly rules: () => readonly PermissionRule[] = () => [],
  ) {
    this.guardedSettings = this.guard(settingsBackend);
  }

  /** Wraps one backend for the agent behind the share guard. */
  private guard(backend: StorageBackend): StorageBackend {
    return new GuardedStorage(backend, 'agent', createShareGuardCheck(this.rules));
  }

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
      if (existing) {
        if (existing.entry !== entry) {
          this.reopen(entry);
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

  private reopen(entry: SharedStorageEntry): void {
    this.opened.set(entry.id, { entry, backend: null, error: null });
    this.open(entry, this.opened.get(entry.id) as OpenEntry);
  }

  private open(entry: SharedStorageEntry, open: OpenEntry): void {
    const setup = this.resolveSetup(entry.setupId);
    if (!setup) {
      open.error = `The storage setup "${entry.setupId}" is not registered.`;
      return;
    }
    try {
      open.backend = this.guard(setup.open({
        directoryPath: this.directoryPath,
        config: entry.config,
        ...(entry.password ? { password: entry.password } : {}),
      }));
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
      return this.guardedSettings.get(key);
    }
    for (const open of this.opened.values()) {
      if (open.entry.uriId === storageId) {
        if (open.entry.access !== 'readonly') {
          throw new Error(
            `The storage "${storageId}" is not shared with the chat agent. Flip its access to read-only in the settings.`,
          );
        }
        if (!open.backend) {
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
