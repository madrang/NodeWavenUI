/**
 * Storage backend on one JSON file inside the workspace folder.
 * The whole file optionally sits under a password: the shared encryption module (`encryption.ts`) seals the
 * serialized values into one envelope, and the file carries the key derivation parameters and a check envelope.
 *
 * Every write serializes the whole file and swaps it in through a temporary file and a rename, so an interrupted
 * write never leaves a half-written file behind. A plain file holds the values as JSON, without encryption.
 */

import { StorageError, type StorageBackend } from './storage.js';
import {
  createKdfParameters,
  decodeKdf,
  deriveKey,
  encodeKdf,
  openRecord,
  readEncryptionSuite,
  sealRecord,
  type EncryptionSuiteId,
  type KdfParameters,
  type UnlockedKey,
} from './encryption.js';
import { nodeFileSystem, type NodeFileSystem } from './node-access.js';

/** Configuration for the JSON file backend. */
export interface JsonFileStorageConfig {
  /** Identifier of this backend instance. The default is "json-file". */
  readonly id?: string;
  /** The absolute path of the JSON file. */
  readonly path: string;
  /** The password that seals the whole file. Undefined or empty keeps the file plain. */
  readonly password?: string;
  /** The encryption suite. The default is "aes-gcm+pbkdf2". */
  readonly suite?: EncryptionSuiteId;
  /** PBKDF2 iteration count. The default is 600000, the OWASP minimum for SHA-256. */
  readonly iterations?: number;
}

const DEFAULT_ITERATIONS = 600000;
const CHECK_VALUE = 'nodewavenui-password-check';
const VALUES_KEY = 'values';
const CHECK_KEY = 'check';
const FILE_VERSION = 1;

/** The parsed content of the settings file. */
interface FileContent {
  readonly encrypted: boolean;
  readonly values: Map<string, string>;
  readonly kdf: KdfParameters | null;
  readonly check: string | null;
  readonly data: string | null;
}

/** Reads and writes one JSON file that holds the workspace settings. */
export class JsonFileStorage implements StorageBackend {
  readonly id: string;
  private readonly path: string;
  private readonly password: string | null;
  private readonly iterations: number;
  private readonly suiteId: EncryptionSuiteId;
  private values: Map<string, string> | null = null;
  private unlocked: UnlockedKey | null = null;
  private ready: Promise<void> | null = null;

  /**
   * @param config The file path and the optional password protection.
   */
  constructor(config: JsonFileStorageConfig) {
    this.id = config.id ?? 'json-file';
    this.path = config.path;
    this.password = typeof config.password === 'string' && config.password.length > 0 ? config.password : null;
    this.iterations = config.iterations ?? DEFAULT_ITERATIONS;
    this.suiteId = readEncryptionSuite(config.suite);
  }

  /**
   * Reads one value.
   *
   * @param key The key to read.
   * @returns The stored value, or null when the key holds no value.
   * @throws StorageError when the password is wrong, the file is damaged, or the filesystem fails.
   */
  async get(key: string): Promise<string | null> {
    await this.ensureReady();
    return this.values?.get(key) ?? null;
  }

  /**
   * Writes one value and persists the file.
   *
   * @param key The key to write.
   * @param value The value to store.
   * @throws StorageError when the password is wrong, the file is damaged, or the filesystem fails.
   */
  async set(key: string, value: string): Promise<void> {
    await this.ensureReady();
    this.requireValues().set(key, value);
    await this.persist();
  }

  /**
   * Removes one value and persists the file.
   *
   * @param key The key to remove.
   * @throws StorageError when the filesystem fails.
   */
  async delete(key: string): Promise<void> {
    await this.ensureReady();
    if (this.requireValues().delete(key)) {
      await this.persist();
    }
  }

  /**
   * Lists every key that holds a value.
   *
   * @returns The keys of the file.
   * @throws StorageError when the file cannot be loaded.
   */
  async keys(): Promise<readonly string[]> {
    await this.ensureReady();
    return [...(this.values?.keys() ?? [])];
  }

  private requireValues(): Map<string, string> {
    if (this.values === null) {
      throw new StorageError('The settings file did not load.');
    }
    return this.values;
  }

  private ensureReady(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.load();
    }
    return this.ready;
  }

  /** Loads the file, decrypts it when it carries a password, and initializes a fresh file when it is absent. */
  private async load(): Promise<void> {
    const fileSystem = this.requireFileSystem();
    let contents: string | null = null;
    if (fileSystem.existsSync(this.path)) {
      try {
        contents = fileSystem.readFileSync(this.path, 'utf-8');
      } catch (error) {
        throw new StorageError(`The settings file "${this.path}" could not be read.`, { cause: error });
      }
    }
    if (contents === null) {
      this.values = new Map();
      if (this.password !== null) {
        const parameters = createKdfParameters(this.suiteId, this.iterations);
        this.unlocked = { key: await deriveKey(this.password, parameters), parameters };
        await this.persist();
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new StorageError(`The settings file "${this.path}" holds no valid JSON.`, { cause: error });
    }
    const content = this.parseContent(parsed);
    if (!content.encrypted) {
      this.values = content.values;
      return;
    }
    if (this.password === null) {
      throw new StorageError('The settings file carries a password, but no password was given.');
    }
    if (content.kdf === null || content.check === null || content.data === null) {
      throw new StorageError('The encrypted settings file carries damaged key derivation parameters.');
    }
    const key = await deriveKey(this.password, content.kdf);
    await openRecord(content.kdf.suite, key, CHECK_KEY, content.check);
    const plain = await openRecord(content.kdf.suite, key, VALUES_KEY, content.data);
    let valuesRecord: unknown;
    try {
      valuesRecord = JSON.parse(plain);
    } catch (error) {
      throw new StorageError('The decrypted settings file holds no valid JSON.', { cause: error });
    }
    this.values = this.parseValues(valuesRecord);
    this.unlocked = { key, parameters: content.kdf };
  }

  private parseContent(parsed: unknown): FileContent {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new StorageError('The settings file carries an invalid shape.');
    }
    const record = parsed as Record<string, unknown>;
    const encrypted = record['encrypted'] === true;
    if (encrypted) {
      const kdfText = record['kdf'];
      return {
        encrypted: true,
        values: new Map(),
        kdf: typeof kdfText === 'string' ? decodeKdf(kdfText) : null,
        check: typeof record['check'] === 'string' ? record['check'] : null,
        data: typeof record['data'] === 'string' ? record['data'] : null,
      };
    }
    return {
      encrypted: false,
      values: this.parseValues(record['values']),
      kdf: null,
      check: null,
      data: null,
    };
  }

  private parseValues(value: unknown): Map<string, string> {
    const values = new Map<string, string>();
    if (typeof value !== 'object' || value === null) {
      return values;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') {
        values.set(key, entry);
      }
    }
    return values;
  }

  /** Serializes the values, seals them when a password is set, and swaps the file in through a rename. */
  private async persist(): Promise<void> {
    const fileSystem = this.requireFileSystem();
    const values = this.requireValues();
    let file: string;
    if (this.password === null) {
      file = JSON.stringify({ v: FILE_VERSION, encrypted: false, values: Object.fromEntries(values) }, null, 2);
    } else {
      const unlocked = this.unlocked;
      if (unlocked === null) {
        throw new StorageError('The encrypted settings file carries no derived key.');
      }
      const plain = JSON.stringify(Object.fromEntries(values));
      file = JSON.stringify(
        {
          v: FILE_VERSION,
          encrypted: true,
          kdf: encodeKdf(unlocked.parameters),
          check: await sealRecord(unlocked.parameters.suite, unlocked.key, CHECK_KEY, CHECK_VALUE),
          data: await sealRecord(unlocked.parameters.suite, unlocked.key, VALUES_KEY, plain),
        },
        null,
        2,
      );
    }
    const temporaryPath = `${this.path}.tmp`;
    try {
      fileSystem.writeFileSync(temporaryPath, `${file}\n`);
      fileSystem.renameSync(temporaryPath, this.path);
    } catch (error) {
      throw new StorageError(`The settings file "${this.path}" could not be written.`, { cause: error });
    }
  }

  private requireFileSystem(): NodeFileSystem {
    const fileSystem = nodeFileSystem();
    if (fileSystem === null) {
      throw new StorageError('The settings file needs the Node fs module of the NW.js page context.');
    }
    return fileSystem;
  }
}
