/**
 * Moves a legacy IndexedDB workspace into the JSON file storage at open time.
 * The old records clear from the profile database once the marker switched to the JSON setup id,
 * so no copy of the settings stays behind. A failed migration falls back to the legacy backend,
 * so the workspace stays readable.
 */

import { copyStorageValues } from '../storage/migration.js';
import { JsonFileStorage } from '../storage/json-file.js';
import type { EncryptionSuiteId } from '../storage/encryption.js';
import type { StorageBackend } from '../storage/storage.js';
import type { WorkspaceSettings } from '../shared/workspace.js';
import { jsonSettingsFilePath, suiteFromConfig } from './storage-setups.js';
import { writeWorkspaceMarker } from './workspace-files.js';
import { log } from './logger.js';

/** The legacy IndexedDB setup ids and their JSON file successors. */
const JSON_SUCCESSORS: Readonly<Record<string, string>> = {
  plain: 'json',
  password: 'json-password',
};

/**
 * Checks whether one storage setup id names a legacy IndexedDB setup.
 *
 * @param storageId The setup id of the workspace marker.
 * @returns True when the id names a setup that only the migration path opens.
 */
export function isLegacyStorageId(storageId: string): boolean {
  return Object.hasOwn(JSON_SUCCESSORS, storageId);
}

/** What one storage migration produced. */
export interface StorageMigrationResult {
  /** The settings with the JSON setup id, for the rewritten marker. */
  readonly settings: WorkspaceSettings;
  /** The JSON file backend that now holds the settings. */
  readonly backend: StorageBackend;
}

/**
 * Moves the settings of one legacy IndexedDB workspace into the JSON file storage.
 * A workspace on a JSON setup already, or an unknown setup id, returns null unchanged.
 * The password path runs after the unlock form verified the password, so the legacy backend decrypts.
 *
 * @param directoryPath The absolute workspace folder path.
 * @param settings The workspace settings from the marker.
 * @param legacyBackend The opened backend of the legacy setup.
 * @param password The password of a protected workspace, or null for a plain one.
 * @returns The migrated settings and backend, or null when nothing moved.
 */
export async function migrateLegacyStorage(
  directoryPath: string,
  settings: WorkspaceSettings,
  legacyBackend: StorageBackend,
  password: string | null,
): Promise<StorageMigrationResult | null> {
  const successor = JSON_SUCCESSORS[settings.storageId];
  if (!successor) {
    return null;
  }
  const suite: EncryptionSuiteId | undefined = suiteFromConfig(settings.storageConfig);
  const jsonBackend = new JsonFileStorage({
    path: jsonSettingsFilePath(directoryPath),
    ...(password ? { password } : {}),
    ...(suite ? { suite } : {}),
  });
  let copiedKeys: readonly string[];
  try {
    copiedKeys = (await copyStorageValues(legacyBackend, jsonBackend)).copiedKeys;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.launcher.warning(
      `the workspace settings could not move into the JSON file. The workspace opens on the old storage: ${message}`,
    );
    return null;
  }
  const migratedSettings: WorkspaceSettings = { ...settings, storageId: successor };
  const writeError = writeWorkspaceMarker(directoryPath, migratedSettings);
  if (writeError) {
    log.launcher.warning(
      `the migrated marker could not be written. The workspace opens on the old storage: ${writeError}`,
    );
    return null;
  }
  // The marker flipped, so the JSON file owns the data. The legacy records clear now, and a
  // failed clear only leaves a copy behind, never a loss.
  try {
    for (const key of copiedKeys) {
      await legacyBackend.delete(key);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.launcher.warning(`the old records could not clear from the profile database: ${message}`);
  }
  log.launcher.informative(
    `the workspace settings moved into ${jsonSettingsFilePath(directoryPath)}: ${copiedKeys.length} keys, and the old records cleared.`,
  );
  return { settings: migratedSettings, backend: jsonBackend };
}
