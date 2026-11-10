/**
 * Access to the Node crypto module and the fs slice for the storage layer.
 * The require global read comes from `src/shared/node-access.ts`, which every compile context
 * shares. The fs slice rides the `nodewavenui` bridge, because the storage backends run in
 * sandboxed app windows.
 */

import { readBridge } from '../shared/bridge.js';
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

/** The async fs slice the JSON settings file reads through. */
export interface JsonFileFs {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
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
 * Builds the JSON settings fs slice over the `nodewavenui` bridge.
 *
 * @returns The slice, or null when the page runs outside an app window.
 */
export function bridgeJsonFileFs(): JsonFileFs | null {
  const fs = readBridge()?.fs;
  if (!fs) {
    return null;
  }
  return {
    read: (path) => fs.readText(path),
    write: (path, text) => fs.writeText(path, text),
    rename: (from, to) => fs.rename(from, to),
    exists: async (path) => (await fs.stat(path)) !== null,
  };
}
