/**
 * Specs for the guarded storage wrapper: the pass-through of an allowed call, the StorageError
 * of a refusal, and the share policy that lets the permission rules deny what a share granted.
 */

import { expect } from 'chai';
import { GuardedStorage } from '../../dist/storage/guarded.js';
import { StorageError, type StorageBackend } from '../../dist/storage/storage.js';
import { createShareGuardCheck } from '../../dist/renderer/storage-shares.js';
import type { PermissionRule } from '../../dist/shared/permissions.js';

/** One in-memory backend that records the calls it serves. */
class RecordingBackend {
  readonly id: string;
  readonly calls: string[] = [];
  private readonly values = new Map<string, string>();

  constructor(id: string) {
    this.id = id;
  }

  async get(key: string): Promise<string | null> {
    this.calls.push(`get ${key}`);
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.calls.push(`set ${key}`);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    this.values.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    this.calls.push('keys');
    return [...this.values.keys()];
  }
}

describe('the guarded storage wrapper', () => {
  it('passes the calls the check allows, and names the backend by its own id', async () => {
    const backend = new RecordingBackend('settings');
    const seen: string[] = [];
    const guarded = new GuardedStorage(backend, 'agent', {
      check: async (principal, action, target) => {
        seen.push(`${principal} ${action} ${target.storageId} ${target.key}`);
      },
    });
    expect(guarded.id).to.equal('settings');
    await guarded.set('a', '1');
    expect(await guarded.get('a')).to.equal('1');
    expect(await guarded.keys()).to.deep.equal(['a']);
    await guarded.delete('a');
    expect(await guarded.get('a')).to.equal(null);
    expect(seen).to.deep.equal([
      'agent write settings a',
      'agent read settings a',
      'agent read settings *',
      'agent write settings a',
      'agent read settings a',
    ]);
    expect(backend.calls).to.deep.equal(['set a', 'get a', 'keys', 'delete a', 'get a']);
  });

  it('fails a refused call with a StorageError, and the backend never runs', async () => {
    const backend = new RecordingBackend('notes');
    const guarded = new GuardedStorage(backend, 'mcp', {
      check: async () => {
        throw new Error('The user denied the card.');
      },
    });
    let refused: unknown = null;
    try {
      await guarded.set('k', 'v');
    } catch (error) {
      refused = error;
    }
    expect(refused).to.be.instanceOf(StorageError);
    expect((refused as StorageError).message).to.match(/refused: The user denied the card\./u);
    expect(backend.calls).to.deep.equal([]);
  });

  it('lets the share policy refuse through a deny rule while a ruleless read passes', async () => {
    const backend = new RecordingBackend('notes');
    const rules: PermissionRule[] = [
      {
        id: 'r1',
        enabled: true,
        principal: '*',
        resource: 'storage:notes',
        effect: 'deny',
        actions: '*',
        keyPrefix: 'token',
      },
    ];
    const guarded = new GuardedStorage(backend, 'agent', createShareGuardCheck(() => rules));
    await backend.set('plain', '1');
    expect(await guarded.get('plain')).to.equal('1');
    let refused: unknown = null;
    try {
      await guarded.get('token-a');
    } catch (error) {
      refused = error;
    }
    expect(refused).to.be.instanceOf(StorageError);
    expect((refused as StorageError).message).to.match(/A permission rule refuses the read of the key "token-a"\./u);
    expect(backend.calls).to.deep.equal(['set plain', 'get plain']);
  });

  it('refuses the share-policy write that no rule grants', async () => {
    const backend = new RecordingBackend('notes');
    const guarded = new GuardedStorage(backend, 'agent', createShareGuardCheck(() => []));
    let refused: unknown = null;
    try {
      await guarded.set('plain', '1');
    } catch (error) {
      refused = error;
    }
    expect(refused).to.be.instanceOf(StorageError);
    expect((refused as StorageError).message).to.match(/The storage share grants reads only\./u);
    expect(backend.calls).to.deep.equal([]);
  });

  it('denies the write of a read-only allow rule through the share policy', async () => {
    const backend = new RecordingBackend('notes');
    const rules: PermissionRule[] = [
      {
        id: 'r2',
        enabled: true,
        principal: 'agent',
        resource: 'storage',
        effect: 'allow',
        actions: '*',
        readOnly: true,
      },
    ];
    const guarded: StorageBackend = new GuardedStorage(backend, 'agent', createShareGuardCheck(() => rules));
    expect(await guarded.get('any')).to.equal(null);
    let refused: unknown = null;
    try {
      await guarded.set('any', '1');
    } catch (error) {
      refused = error;
    }
    expect(refused).to.be.instanceOf(StorageError);
    expect((refused as StorageError).message).to.match(/A permission rule refuses the write of the key "any"\./u);
    expect(backend.calls).to.deep.equal(['get any']);
  });
});
