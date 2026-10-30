/**
 * Moves a legacy IndexedDB workspace into the JSON file storage at open time.
 * The old records stay behind in the profile database, and the marker switches to the JSON setup ids.
 * A failed migration falls back to the legacy backend, so the workspace stays readable.
 */

import { copyStorageValues } from '../storage/migration.js';
import { JsonFileStorage } from '../storage/json-file.js';
import type { EncryptionSuiteId } from '../storage/encryption.js';
import type { StorageBackend } from '../storage/storage.js';
import type { WorkspaceSettings } from '../shared/workspace.js';
import { jsonSettingsFilePath, suiteFromConfig } from './storage-setups.js';
import { writeWorkspaceMarker } from './workspace-files.js';

/** The legacy IndexedDB setup ids and their JSON file successors. */
const JSON_SUCCESSORS: Readonly<Record<string, string>> = {
  plain: 'json',
  password: 'json-password',
};

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
  if (successor === undefined) {
    return null;
  }
  const suite: EncryptionSuiteId | undefined = suiteFromConfig(settings.storageConfig);
  const jsonBackend = new JsonFileStorage({
    path: jsonSettingsFilePath(directoryPath),
    ...(password !== null ? { password } : {}),
    ...(suite !== undefined ? { suite } : {}),
  });
  let copiedCount: number;
  try {
    copiedCount = (await copyStorageValues(legacyBackend, jsonBackend)).copiedKeys.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[NodeWavenUI] the workspace settings could not move into the JSON file. The workspace opens on the old storage: ${message}`,
    );
    return null;
  }
  const migratedSettings: WorkspaceSettings = { ...settings, storageId: successor };
  const writeError = writeWorkspaceMarker(directoryPath, migratedSettings);
  if (writeError !== null) {
    console.warn(
      `[NodeWavenUI] the migrated marker could not be written. The workspace opens on the old storage: ${writeError}`,
    );
    return null;
  }
  console.info(
    `[NodeWavenUI] the workspace settings moved into ${jsonSettingsFilePath(directoryPath)}: ${copiedCount} keys.`,
  );
  return { settings: migratedSettings, backend: jsonBackend };
}
