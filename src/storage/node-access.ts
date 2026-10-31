/**
 * Access to the Node crypto and fs modules for the storage layer.
 * The require global read comes from `src/shared/node-access.ts`, which every compile context shares.
 */

import { requireNodeModule } from '../shared/node-access.js';

/** The slice of the Node crypto module the storage layer uses. */
export interface NodeCrypto {
  scryptSync?: (
    password: string,
    salt: Uint8Array<ArrayBuffer>,
    length: number,
    options: { N: number; r: number; p: number; maxmem: number },
  ) => Uint8Array<ArrayBuffer>;
  createCipheriv?: (
    algorithm: string,
    key: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    options: { authTagLength: number },
  ) => NodeCipher;
  createDecipheriv?: (
    algorithm: string,
    key: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    options: { authTagLength: number },
  ) => NodeDecipher;
}

/** An authenticated Node cipher. */
export interface NodeCipher {
  update(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  final(): Uint8Array<ArrayBuffer>;
  getAuthTag(): Uint8Array<ArrayBuffer>;
  setAAD(aad: Uint8Array<ArrayBuffer>): unknown;
}

/** An authenticated Node decipher. */
export interface NodeDecipher {
  update(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  final(): Uint8Array<ArrayBuffer>;
  getAuthTag(): Uint8Array<ArrayBuffer>;
  setAAD(aad: Uint8Array<ArrayBuffer>): unknown;
  setAuthTag(tag: Uint8Array<ArrayBuffer>): unknown;
}

/** The slice of the Node fs module the storage layer uses. */
export interface NodeFileSystem {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, contents: string): void;
  renameSync(from: string, to: string): void;
  existsSync(path: string): boolean;
}

/**
 * Reads the Node crypto module.
 *
 * @returns The module, or null when the page runs without the NW.js Node context.
 */
export function nodeCrypto(): NodeCrypto | null {
  const module = requireNodeModule('crypto');
  if (typeof module !== 'object' || module === null) {
    return null;
  }
  return module as NodeCrypto;
}

/**
 * Reads the Node fs module.
 *
 * @returns The module, or null when the page runs without the NW.js Node context or the module lacks a needed function.
 */
export function nodeFileSystem(): NodeFileSystem | null {
  const module = requireNodeModule('fs');
  if (typeof module !== 'object' || module === null) {
    return null;
  }
  const candidate = module as Partial<NodeFileSystem>;
  if (
    typeof candidate.readFileSync !== 'function' ||
    typeof candidate.writeFileSync !== 'function' ||
    typeof candidate.renameSync !== 'function' ||
    typeof candidate.existsSync !== 'function'
  ) {
    return null;
  }
  return candidate as NodeFileSystem;
}
