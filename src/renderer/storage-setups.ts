/**
 * The built-in storage setups offered in the setup wizard.
 * A setup lists in the wizard dropdown, carries its own UI definition, and opens the backend for a workspace.
 * Each workspace keeps its own IndexedDB database, named with a hash of the folder path.
 */

import { IndexedDbStorage } from '../storage/indexeddb.js';
import { JsonFileStorage } from '../storage/json-file.js';
import {
  PasswordEncryptedStorage,
  listEncryptionSuites,
  readEncryptionSuite,
  type EncryptionSuiteId,
  type PasswordEncryptedStorageConfig,
} from '../storage/password-encrypted.js';
import type {
  PluginFieldDefinition,
  PluginRegistry,
  StorageConfiguration,
  StorageSetup,
} from '../plugins.js';

const MINIMUM_PASSWORD_LENGTH = 8;

/** The name of the JSON settings file inside a workspace folder. */
const JSON_SETTINGS_FILE = '.nodewavenui-settings.json';

/**
 * Builds the path of the JSON settings file of one workspace folder.
 *
 * @param directoryPath The absolute workspace folder path.
 * @returns The absolute settings file path.
 */
export function jsonSettingsFilePath(directoryPath: string): string {
  return `${directoryPath.replace(/[\\/]+$/, '')}/${JSON_SETTINGS_FILE}`;
}

/**
 * Builds a stable database name for one workspace folder.
 * The name hashes the folder path, so it stays short and filesystem-safe.
 *
 * @param directoryPath The absolute workspace folder path.
 * @returns The IndexedDB database name of the workspace.
 */
function databaseNameFor(directoryPath: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < directoryPath.length; index += 1) {
    hash ^= directoryPath.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `nodewavenui-${hash.toString(16)}`;
}

/**
 * Reads the encryption suite out of a stored storage config.
 *
 * @param config The storage config of the workspace marker.
 * @returns The suite id, or undefined when the config carries none.
 */
export function suiteFromConfig(config: unknown): EncryptionSuiteId | undefined {
  if (typeof config !== 'object' || config === null) {
    return undefined;
  }
  const suite = (config as Record<string, unknown>).suite;
  return typeof suite === 'string' ? readEncryptionSuite(suite) : undefined;
}

/** The UI definition of the encrypted setup: the encryption suite picker and the password fields. */
function passwordFields(): readonly PluginFieldDefinition[] {
  return [
    {
      id: 'suite',
      label: 'Encryption',
      kind: 'select',
      options: listEncryptionSuites().map((suite) => ({
        value: suite.id,
        label: suite.available ? suite.label : `${suite.label} (needs the Node context)`,
        enabled: suite.available,
      })),
    },
    { id: 'password', label: 'Password', kind: 'password' },
    { id: 'confirm', label: 'Confirm password', kind: 'password' },
  ];
}

/**
 * Validates the encrypted setup fields and assembles its configuration.
 *
 * @param values The field values by field id.
 * @returns The configuration, or an error message for the user.
 */
function readPasswordConfiguration(values: Readonly<Record<string, string>>): StorageConfiguration | string {
  const suite = listEncryptionSuites().find((candidate) => candidate.id === values.suite);
  if (suite === undefined || !suite.available) {
    return 'This encryption suite is not available here.';
  }
  const password = values.password ?? '';
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return `The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
  }
  if (password !== values.confirm) {
    return 'The passwords do not match.';
  }
  return { config: { suite: values.suite }, password };
}

/**
 * Registers the built-in storage setups on one registry.
 *
 * @param registry The plugin registry of the app.
 */
export function registerBuiltinStorageSetups(registry: PluginRegistry): void {
  registry.registerStorageSetup({
    id: 'plain',
    label: 'Local database (no password)',
    needsPassword: false,
    readConfiguration: () => ({ config: null, password: null }),
    open: ({ directoryPath }) => new IndexedDbStorage({ databaseName: databaseNameFor(directoryPath) }),
  });
  registry.registerStorageSetup({
    id: 'password',
    label: 'Local database, encrypted with a password',
    needsPassword: true,
    fields: passwordFields(),
    readConfiguration: readPasswordConfiguration,
    open: ({ directoryPath, config, password }) => {
      const suite = suiteFromConfig(config);
      const encryptionConfig: PasswordEncryptedStorageConfig = suite !== undefined ? { suite } : {};
      return new PasswordEncryptedStorage(
        new IndexedDbStorage({ databaseName: databaseNameFor(directoryPath) }),
        password ?? '',
        encryptionConfig,
      );
    },
  });
  registry.registerStorageSetup({
    id: 'json',
    label: 'JSON file in the workspace (no password)',
    needsPassword: false,
    readConfiguration: () => ({ config: null, password: null }),
    open: ({ directoryPath }) => new JsonFileStorage({ path: jsonSettingsFilePath(directoryPath) }),
  });
  registry.registerStorageSetup({
    id: 'json-password',
    label: 'JSON file in the workspace, sealed with a password',
    needsPassword: true,
    fields: passwordFields(),
    readConfiguration: readPasswordConfiguration,
    open: ({ directoryPath, config, password }) => {
      const suite = suiteFromConfig(config);
      return new JsonFileStorage({
        path: jsonSettingsFilePath(directoryPath),
        password: password ?? '',
        ...(suite !== undefined ? { suite } : {}),
      });
    },
  });
}
