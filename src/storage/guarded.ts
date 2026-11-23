/**
 * The guarded storage wrapper: one StorageBackend behind the permission gate. Every read and
 * write names its principal and its storage target, so the persisted rules decide and an ask
 * default reaches the approval card of the surface that injected the check. The wrapper carries
 * no policy of its own: the injected check allows, denies, or asks, and a refusal fails the call
 * with a StorageError. The module stays free of platform dependencies, so the renderer, the
 * worker core, and the main process can wrap the same backend the same way.
 */

import { StorageError, type StorageBackend } from './storage.js';

/** The principals that may reach a storage through a guard. */
export type GuardedPrincipal = 'agent' | 'mcp';

/** The permission check of one guarded storage call. It throws to refuse the call. */
export interface StoragePermissionCheck {
  check(
    principal: GuardedPrincipal,
    action: 'read' | 'write',
    target: { kind: 'storage'; storageId: string; key: string },
    detail: string,
    source?: string | null,
  ): Promise<void>;
}

/** Reads the message of one refusal. */
function refusalText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wraps one storage backend for one principal: every call passes the injected check first. */
export class GuardedStorage implements StorageBackend {
  readonly id: string;

  /**
   * @param backend The wrapped backend. The id passes through, so the guard stays invisible to
   * the consumers that name the storage by its id.
   * @param principal The principal every call names.
   * @param check The permission check that allows, denies, or asks.
   * @param source The source the check attributes its request to, when the surface owns one.
   */
  constructor(
    private readonly backend: StorageBackend,
    private readonly principal: GuardedPrincipal,
    private readonly check: StoragePermissionCheck,
    private readonly source?: string | null,
  ) {
    this.id = backend.id;
  }

  /** @throws StorageError when the check refuses the read. */
  async get(key: string): Promise<string | null> {
    await this.guard('read', key);
    return this.backend.get(key);
  }

  /** @throws StorageError when the check refuses the write. */
  async set(key: string, value: string): Promise<void> {
    await this.guard('write', key);
    return this.backend.set(key, value);
  }

  /** @throws StorageError when the check refuses the write. */
  async delete(key: string): Promise<void> {
    await this.guard('write', key);
    return this.backend.delete(key);
  }

  /** Lists every key. The star key names the whole storage, so a key-prefix rule matches no
   * keys call while a storage-wide rule decides it.
   * @throws StorageError when the check refuses the read. */
  async keys(): Promise<readonly string[]> {
    await this.guard('read', '*');
    return this.backend.keys();
  }

  /** Runs one check and fails the call with a StorageError on its refusal. */
  private async guard(action: 'read' | 'write', key: string): Promise<void> {
    try {
      await this.check.check(
        this.principal,
        action,
        { kind: 'storage', storageId: this.backend.id, key },
        `${action} the key "${key}" of the storage "${this.backend.id}"`,
        this.source ?? undefined,
      );
    } catch (error) {
      throw new StorageError(
        `The ${action} of the key "${key}" on the storage "${this.backend.id}" was refused: ${refusalText(error)}`,
        { cause: error },
      );
    }
  }
}
