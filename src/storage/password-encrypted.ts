/**
 * Storage backend that encrypts every value with a password before it reaches an inner backend.
 * The suites, envelopes, and key derivation records come from the shared encryption module (`encryption.ts`).
 *
 * The suite of a store is fixed in its key derivation parameters, which live in a reserved inner key.
 * Every record uses a fresh 96-bit IV, and the record key plus the envelope version travel as additional authenticated data.
 * A password check record lives in a reserved inner key, so a wrong password fails at first use.
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
  type EncryptionSuiteOption,
  type EncryptionKey,
  type KdfParameters,
  type UnlockedKey,
} from './encryption.js';

export { listEncryptionSuites, readEncryptionSuite } from './encryption.js';
export type { EncryptionSuiteId, EncryptionSuiteOption } from './encryption.js';

/** Configuration for the password-encrypted backend. */
export interface PasswordEncryptedStorageConfig {
  /** Identifier of this backend instance. The default is the inner id plus "+password". */
  readonly id?: string;
  /** The encryption suite. The default is "aes-gcm+pbkdf2". */
  readonly suite?: EncryptionSuiteId;
  /** PBKDF2 iteration count. The default is 600000, the OWASP minimum for SHA-256. */
  readonly iterations?: number;
}

const DEFAULT_ITERATIONS = 600000;
const KDF_KEY = '__nodewavenui/kdf__';
const CHECK_KEY = '__nodewavenui/check__';
const CHECK_VALUE = 'nodewavenui-password-check';

/** Encrypts every value with a password before it reaches the inner backend. */
export class PasswordEncryptedStorage implements StorageBackend {
  readonly id: string;
  private readonly inner: StorageBackend;
  private password: string;
  private readonly iterations: number;
  private readonly suiteId: EncryptionSuiteId;
  private ready: Promise<UnlockedKey> | null = null;

  /**
   * @param inner The backend that holds the encrypted records. Give this wrapper its own inner instance.
   * @param password The password that protects the records.
   * @param config The optional identifier, suite, and PBKDF2 iteration count.
   */
  constructor(inner: StorageBackend, password: string, config: PasswordEncryptedStorageConfig = {}) {
    this.inner = inner;
    this.password = password;
    this.iterations = config.iterations ?? DEFAULT_ITERATIONS;
    this.suiteId = readEncryptionSuite(config.suite);
    this.id = config.id ?? `${inner.id}+password`;
  }

  /**
   * Reads and decrypts one value.
   *
   * @param key The key to read.
   * @returns The stored value, or null when the key holds no value.
   * @throws StorageError when the password is wrong, the record is damaged, or the inner backend fails.
   */
  async get(key: string): Promise<string | null> {
    const unlocked = await this.ensureReady();
    const envelope = await this.inner.get(key);
    if (envelope === null) {
      return null;
    }
    return openRecord(unlocked.parameters.suite, unlocked.key, key, envelope);
  }

  /**
   * Encrypts and writes one value.
   *
   * @param key The key to write.
   * @param value The value to store.
   * @throws StorageError when the inner backend fails.
   */
  async set(key: string, value: string): Promise<void> {
    const unlocked = await this.ensureReady();
    await this.inner.set(key, await sealRecord(unlocked.parameters.suite, unlocked.key, key, value));
  }

  /**
   * Removes one value.
   *
   * @param key The key to remove.
   * @throws StorageError when the inner backend fails.
   */
  async delete(key: string): Promise<void> {
    await this.inner.delete(key);
  }

  /**
   * Lists every key that holds a value. The reserved keys stay hidden.
   *
   * @returns The keys of the wrapped records.
   * @throws StorageError when the inner backend fails.
   */
  async keys(): Promise<readonly string[]> {
    const allKeys = await this.inner.keys();
    return allKeys.filter((key) => key !== KDF_KEY && key !== CHECK_KEY);
  }

  /**
   * Re-keys the store under a new password, keeping the suite.
   * Every record is decrypted under the old key and written back under a new salt.
   * An interrupted change can leave a mixed store, because the inner backend has no transaction that spans records.
   *
   * @param newPassword The password that protects the records from now on.
   * @throws StorageError when the old password does not open the store, or a record is damaged.
   */
  async changePassword(newPassword: string): Promise<void> {
    const unlocked = await this.ensureReady();
    const storedKeys = await this.keys();
    const values = new Map<string, string>();
    for (const key of storedKeys) {
      const envelope = await this.inner.get(key);
      if (envelope === null) {
        continue;
      }
      values.set(key, await openRecord(unlocked.parameters.suite, unlocked.key, key, envelope));
    }
    const newUnlocked = await this.createUnlocked(newPassword, unlocked.parameters.iterations, unlocked.parameters.suite);
    await this.inner.set(KDF_KEY, encodeKdf(newUnlocked.parameters));
    for (const [key, value] of values) {
      await this.inner.set(key, await sealRecord(newUnlocked.parameters.suite, newUnlocked.key, key, value));
    }
    await this.inner.set(CHECK_KEY, await sealRecord(newUnlocked.parameters.suite, newUnlocked.key, CHECK_KEY, CHECK_VALUE));
    this.password = newPassword;
    this.ready = Promise.resolve(newUnlocked);
  }

  private ensureReady(): Promise<UnlockedKey> {
    if (this.ready === null) {
      this.ready = this.unlock();
    }
    return this.ready;
  }

  /** Derives a fresh unlocked key under a new random salt. */
  private async createUnlocked(
    password: string,
    iterations: number,
    suite: EncryptionSuiteId,
  ): Promise<UnlockedKey> {
    const parameters: KdfParameters = createKdfParameters(suite, iterations);
    return { key: await deriveKey(password, parameters), parameters };
  }

  /**
   * Reads or creates the key derivation parameters, derives the key, and verifies the password against the check record.
   * A fresh store writes its check record. An existing store must decrypt it, so a wrong password fails at first use.
   */
  private async unlock(): Promise<UnlockedKey> {
    const parameters = await this.readOrCreateParameters();
    const key: EncryptionKey = await deriveKey(this.password, parameters);
    const unlocked: UnlockedKey = { key, parameters };
    const checkEnvelope = await this.inner.get(CHECK_KEY);
    if (checkEnvelope === null) {
      await this.inner.set(CHECK_KEY, await sealRecord(parameters.suite, key, CHECK_KEY, CHECK_VALUE));
      return unlocked;
    }
    await openRecord(parameters.suite, key, CHECK_KEY, checkEnvelope);
    return unlocked;
  }

  private async readOrCreateParameters(): Promise<KdfParameters> {
    const encoded = await this.inner.get(KDF_KEY);
    if (encoded !== null) {
      const parameters = decodeKdf(encoded);
      if (parameters !== null) {
        return parameters;
      }
      throw new StorageError('The store carries damaged key derivation parameters.');
    }
    const parameters: KdfParameters = createKdfParameters(this.suiteId, this.iterations);
    await this.inner.set(KDF_KEY, encodeKdf(parameters));
    return parameters;
  }
}
