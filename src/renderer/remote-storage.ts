/**
 * The storage backend over the background core: the settings of the workspace live in the worker
 * process, and this backend speaks the settings channels of the core contract through the
 * bridge. The workspace page builds it at boot once the core reports ready, and every consumer
 * of a StorageBackend works unchanged.
 */

import { StorageError, type StorageBackend } from '../storage/storage.js';
import type { NodeWavenBridge } from '../shared/bridge.js';
import type { CoreStatus } from '../shared/core-api.js';
import { log } from './logger.js';

/**
 * Reads one core status value.
 *
 * @param value The pushed or answered state. It can have any type.
 * @returns The status, or null on an invalid shape.
 */
function readCoreStatus(value: unknown): CoreStatus | null {
  if (typeof value !== 'object' || !value) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.state !== 'starting' && candidate.state !== 'ready' && candidate.state !== 'failed') {
    return null;
  }
  return {
    state: candidate.state,
    ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
  };
}

/**
 * Waits for the background core of this workspace to report its final state.
 * The subscription runs before the status read, so no transition slips between the two.
 *
 * @param bridge The bridge of the workspace window.
 * @returns The status that ended the wait.
 * @throws Error when the workspace window runs without a bridge or the core never started.
 */
async function waitForCoreStatus(bridge: NodeWavenBridge): Promise<CoreStatus> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status: CoreStatus): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(status);
    };
    bridge.workspace.onWorkspaceEvent('core.state', (payload) => {
      const status = readCoreStatus(payload);
      if (status && status.state !== 'starting') {
        finish(status);
      }
    });
    void bridge.core.status().then(
      (value) => {
        if (!value) {
          if (!settled) {
            settled = true;
            reject(new Error('This workspace opened without the background core.'));
          }
          return;
        }
        const status = readCoreStatus(value) ?? { state: 'failed' as const, error: 'The core state carries an invalid shape.' };
        if (status.state !== 'starting') {
          finish(status);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}

/**
 * Opens the storage of the workspace through the background core.
 *
 * @param bridge The bridge of the workspace window.
 * @returns The backend that speaks the settings channels of the core.
 * @throws Error when the core failed or never started. The message explains the failure.
 */
export async function openCoreStorage(bridge: NodeWavenBridge): Promise<StorageBackend> {
  const status = await waitForCoreStatus(bridge);
  if (status.state === 'failed') {
    const message = status.error ?? 'The background core of this workspace failed.';
    log.main.error(`the worker core failed to open the storage: ${message}`);
    throw new Error(message);
  }
  return new CoreStorageBackend(bridge);
}

/** The settings storage over the core request channels. */
class CoreStorageBackend implements StorageBackend {
  readonly id = 'core';
  private readonly bridge: NodeWavenBridge;

  constructor(bridge: NodeWavenBridge) {
    this.bridge = bridge;
  }

  /** @throws StorageError when the core request fails. */
  async get(key: string): Promise<string | null> {
    const value = await this.request('settings.get', { key });
    return typeof value === 'string' ? value : null;
  }

  /** @throws StorageError when the core request fails. */
  async set(key: string, value: string): Promise<void> {
    await this.request('settings.set', { key, value });
  }

  /** @throws StorageError when the core request fails. */
  async delete(key: string): Promise<void> {
    await this.request('settings.delete', { key });
  }

  /** @throws StorageError when the core request fails. */
  async keys(): Promise<readonly string[]> {
    const value = await this.request('settings.keys');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  /** Runs one core request and wraps its failure in a StorageError. */
  private async request(channel: string, payload?: unknown): Promise<unknown> {
    try {
      return await this.bridge.core.request(channel, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StorageError(`The core request "${channel}" failed: ${message}`, { cause: error });
    }
  }
}
