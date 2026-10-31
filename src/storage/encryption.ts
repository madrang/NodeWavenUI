/**
 * Shared password encryption for the storage backends.
 * Every backend that protects data with a password uses these suites, envelopes, and key derivation records:
 * the per-value wrapper (`password-encrypted.ts`) and the whole-file JSON storage (`json-file.ts`).
 *
 * Cryptography comes in selectable suites (key derivation plus authenticated cipher):
 * - "aes-gcm+pbkdf2": WebCrypto PBKDF2 with SHA-256 (600,000 iterations by default) and AES-256-GCM. Works everywhere, also in a plain browser.
 * - "aes-gcm+scrypt" and "chacha20-poly1305+scrypt": scrypt key derivation (memory-hard, OWASP-second choice) and authenticated ciphers through the Node crypto module of the NW.js page context.
 *
 * Every record uses a fresh 96-bit IV, and the record key plus the envelope version travel as additional authenticated data.
 * Records carry the version prefix "nwenc1" for future migrations.
 */

import { StorageError } from './storage.js';
import { nodeCrypto } from './node-access.js';

/** The selectable encryption suites. */
export type EncryptionSuiteId = 'aes-gcm+pbkdf2' | 'aes-gcm+scrypt' | 'chacha20-poly1305+scrypt';

/** One suite entry for a selection list. */
export interface EncryptionSuiteOption {
  readonly id: EncryptionSuiteId;
  readonly label: string;
  /** False when the suite needs the Node crypto module and the page runs without it. */
  readonly available: boolean;
}

/** The derived key material of a suite. */
export type EncryptionKey =
  | { readonly kind: 'webcrypto'; readonly key: CryptoKey }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array<ArrayBuffer> };

/** The parameters record that fixes a suite to one salt. */
export interface KdfParameters {
  readonly suite: EncryptionSuiteId;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly iterations: number;
  readonly scrypt: { readonly N: number; readonly r: number; readonly p: number };
}

/** A derived key together with the parameters it came from. */
export interface UnlockedKey {
  readonly key: EncryptionKey;
  readonly parameters: KdfParameters;
}

/** One encryption suite: derivation, encryption, decryption. */
interface EncryptionSuite {
  readonly deriveKey: (password: string, parameters: KdfParameters) => Promise<EncryptionKey>;
  readonly encrypt: (
    key: EncryptionKey,
    iv: Uint8Array<ArrayBuffer>,
    aad: Uint8Array<ArrayBuffer>,
    plain: Uint8Array<ArrayBuffer>,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly decrypt: (
    key: EncryptionKey,
    iv: Uint8Array<ArrayBuffer>,
    aad: Uint8Array<ArrayBuffer>,
    sealed: Uint8Array<ArrayBuffer>,
  ) => Promise<string>;
}

const DEFAULT_SUITE: EncryptionSuiteId = 'aes-gcm+pbkdf2';

/** The default PBKDF2 iteration count, shared by every storage module that derives a key from a password. */
export const DEFAULT_ITERATIONS = 600000;
const DEFAULT_SCRYPT = { N: 65536, r: 8, p: 1 } as const;
const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_PREFIX = 'nwenc1';

const SUITE_LABELS: Record<EncryptionSuiteId, string> = {
  'aes-gcm+pbkdf2': 'AES-256-GCM with PBKDF2-SHA256',
  'aes-gcm+scrypt': 'AES-256-GCM with scrypt',
  'chacha20-poly1305+scrypt': 'ChaCha20-Poly1305 with scrypt',
};

/**
 * Lists every encryption suite for a selection list.
 *
 * @returns The suites with their labels and availability.
 */
export function listEncryptionSuites(): readonly EncryptionSuiteOption[] {
  const nodeAvailable = nodeCrypto() !== null;
  return (Object.keys(SUITE_LABELS) as EncryptionSuiteId[]).map((id) => ({
    id,
    label: SUITE_LABELS[id],
    available: id === 'aes-gcm+pbkdf2' || nodeAvailable,
  }));
}

/**
 * Reads one suite option by id, with the default applied.
 *
 * @param value The configured suite id, or null for the default.
 * @returns The suite id.
 */
export function readEncryptionSuite(value: unknown): EncryptionSuiteId {
  return typeof value === 'string' && value in SUITE_LABELS ? (value as EncryptionSuiteId) : DEFAULT_SUITE;
}

function subtle(): SubtleCrypto {
  const subtleApi = globalThis.crypto?.subtle;
  if (subtleApi === undefined) {
    throw new StorageError('The Web Crypto API needs a secure context, and this page is not one.');
  }
  return subtleApi;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function additionalData(keyName: string): Uint8Array<ArrayBuffer> {
  return utf8Encode(`${ENVELOPE_PREFIX}:${keyName}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Concatenates byte arrays. */
function concatBytes(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** Derives raw key bytes with scrypt through the Node crypto module. */
function deriveScryptKeyBytes(password: string, parameters: KdfParameters): Uint8Array<ArrayBuffer> {
  const cryptoModule = nodeCrypto();
  if (cryptoModule === null || typeof cryptoModule.scryptSync !== 'function') {
    throw new StorageError('The Node crypto module carries no scryptSync.');
  }
  return cryptoModule.scryptSync(password, parameters.salt, KEY_BYTES, {
    N: parameters.scrypt.N,
    r: parameters.scrypt.r,
    p: parameters.scrypt.p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

/** Encrypts with AES-256-GCM through WebCrypto. */
async function webCryptoAesEncrypt(
  key: EncryptionKey,
  iv: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
  plain: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (key.kind !== 'webcrypto') {
    throw new StorageError('This store derived a non-WebCrypto key.');
  }
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key.key, plain);
  return new Uint8Array(sealed);
}

/** Decrypts AES-256-GCM through WebCrypto. */
async function webCryptoAesDecrypt(
  key: EncryptionKey,
  iv: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
  sealed: Uint8Array<ArrayBuffer>,
): Promise<string> {
  if (key.kind !== 'webcrypto') {
    throw new StorageError('This store derived a non-WebCrypto key.');
  }
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key.key, sealed);
  return new TextDecoder().decode(plain);
}

async function deriveWebCryptoAesKey(rawKey: Uint8Array<ArrayBuffer>): Promise<EncryptionKey> {
  const key = await subtle().importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { kind: 'webcrypto', key };
}

/** The suites, keyed by id. Each entry states its own availability rule. */
const SUITES: Record<EncryptionSuiteId, EncryptionSuite> = {
  'aes-gcm+pbkdf2': {
    async deriveKey(password, parameters) {
      const material = await subtle().importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = await subtle().deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: parameters.salt, iterations: parameters.iterations },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      return { kind: 'webcrypto', key };
    },
    encrypt: webCryptoAesEncrypt,
    decrypt: webCryptoAesDecrypt,
  },
  'aes-gcm+scrypt': {
    async deriveKey(password, parameters) {
      return deriveWebCryptoAesKey(deriveScryptKeyBytes(password, parameters));
    },
    encrypt: webCryptoAesEncrypt,
    decrypt: webCryptoAesDecrypt,
  },
  'chacha20-poly1305+scrypt': {
    async deriveKey(password, parameters) {
      return { kind: 'bytes', bytes: deriveScryptKeyBytes(password, parameters) };
    },
    async encrypt(key, iv, aad, plain) {
      if (key.kind !== 'bytes') {
        throw new StorageError('This store derived a non-Node key.');
      }
      const cryptoModule = nodeCrypto();
      if (cryptoModule === null || typeof cryptoModule.createCipheriv !== 'function') {
        throw new StorageError('The Node crypto module carries no createCipheriv.');
      }
      const createCipheriv = cryptoModule.createCipheriv;
      const cipher = createCipheriv('chacha20-poly1305', key.bytes, iv, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(aad);
      return concatBytes([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    async decrypt(key, iv, aad, sealed) {
      if (key.kind !== 'bytes') {
        throw new StorageError('This store derived a non-Node key.');
      }
      const cryptoModule = nodeCrypto();
      if (cryptoModule === null || typeof cryptoModule.createDecipheriv !== 'function') {
        throw new StorageError('The Node crypto module carries no createDecipheriv.');
      }
      const createDecipheriv = cryptoModule.createDecipheriv;
      const tagOffset = sealed.length - AUTH_TAG_BYTES;
      if (tagOffset <= 0) {
        throw new StorageError('The record is shorter than an authentication tag.');
      }
      const body = sealed.slice(0, tagOffset);
      const tag = sealed.slice(tagOffset);
      const decipher = createDecipheriv('chacha20-poly1305', key.bytes, iv, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      try {
        return new TextDecoder().decode(concatBytes([decipher.update(body), decipher.final()]));
      } catch (error) {
        throw new StorageError('Decryption failed. The password is wrong, or the record is damaged.', {
          cause: error,
        });
      }
    },
  },
};

/**
 * Builds fresh key derivation parameters with a random salt.
 *
 * @param suite The suite of the parameters.
 * @param iterations The PBKDF2 iteration count.
 * @returns The parameters.
 */
export function createKdfParameters(suite: EncryptionSuiteId, iterations: number): KdfParameters {
  return {
    suite,
    salt: randomBytes(SALT_BYTES),
    iterations,
    scrypt: { ...DEFAULT_SCRYPT },
  };
}

/**
 * Derives the key of one suite from a password and its parameters.
 *
 * @param password The password.
 * @param parameters The key derivation parameters.
 * @returns The derived key material.
 */
export function deriveKey(password: string, parameters: KdfParameters): Promise<EncryptionKey> {
  return SUITES[parameters.suite].deriveKey(password, parameters);
}

/**
 * Encrypts one string into an envelope record. The key name travels as additional authenticated data.
 *
 * @param suite The suite that derived the key.
 * @param key The derived key material.
 * @param keyName The record name that binds the envelope.
 * @param value The plaintext string.
 * @returns The envelope, in the form "nwenc1.iv.sealed".
 */
export async function sealRecord(
  suite: EncryptionSuiteId,
  key: EncryptionKey,
  keyName: string,
  value: string,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await SUITES[suite].encrypt(key, iv, additionalData(keyName), utf8Encode(value));
  return `${ENVELOPE_PREFIX}.${bytesToBase64(iv)}.${bytesToBase64(sealed)}`;
}

/**
 * Decrypts one envelope record.
 *
 * @param suite The suite that derived the key.
 * @param key The derived key material.
 * @param keyName The record name that binds the envelope.
 * @param envelope The envelope, in the form "nwenc1.iv.sealed".
 * @returns The plaintext string.
 * @throws StorageError when the envelope is damaged, the password is wrong, or the record is damaged.
 */
export async function openRecord(
  suite: EncryptionSuiteId,
  key: EncryptionKey,
  keyName: string,
  envelope: string,
): Promise<string> {
  const [prefix, ivText, sealedText] = envelope.split('.');
  if (prefix !== ENVELOPE_PREFIX || ivText === undefined || sealedText === undefined) {
    throw new StorageError(`The record "${keyName}" is not a ${ENVELOPE_PREFIX} envelope.`);
  }
  try {
    return await SUITES[suite].decrypt(key, base64ToBytes(ivText), additionalData(keyName), base64ToBytes(sealedText));
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('Decryption failed. The password is wrong, or the record is damaged.', { cause: error });
  }
}

/**
 * Encodes key derivation parameters into their stored JSON form.
 *
 * @param parameters The parameters.
 * @returns The JSON string.
 */
export function encodeKdf(parameters: KdfParameters): string {
  return JSON.stringify({
    v: 2,
    suite: parameters.suite,
    salt: bytesToBase64(parameters.salt),
    iterations: parameters.iterations,
    scrypt: parameters.scrypt,
  });
}

/**
 * Reads the key derivation parameters from their stored JSON form.
 * A record without a suite is a version 1 store, which always used PBKDF2 with AES-GCM.
 *
 * @param value The stored string.
 * @returns The parameters, or null when the string is damaged.
 */
export function decodeKdf(value: string): KdfParameters | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.salt !== 'string') {
      return null;
    }
    const scryptRecord = record.scrypt;
    const scryptOk =
      typeof scryptRecord === 'object' &&
      scryptRecord !== null &&
      typeof (scryptRecord as Record<string, unknown>).N === 'number' &&
      typeof (scryptRecord as Record<string, unknown>).r === 'number' &&
      typeof (scryptRecord as Record<string, unknown>).p === 'number';
    return {
      suite: readEncryptionSuite(record.suite),
      salt: base64ToBytes(record.salt),
      iterations: typeof record.iterations === 'number' ? record.iterations : DEFAULT_ITERATIONS,
      scrypt: scryptOk ? (scryptRecord as { N: number; r: number; p: number }) : { ...DEFAULT_SCRYPT },
    };
  } catch {
    return null;
  }
}
