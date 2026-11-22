/**
 * The direct fs slice of the worker: the JsonFileFs implementation over node:fs. The worker
 * holds a Node context, so the settings file needs no bridge. The storage layer stays sync
 * under it, the same contract the bridge slice serves in the renderers.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { JsonFileFs } from '../storage/node-access.js';

/** The fs slice over the real filesystem of the worker. */
export const nodeJsonFileFs: JsonFileFs = {
  read: (path) => Promise.resolve(readFileSync(path, 'utf-8')),
  write: (path, text) => {
    writeFileSync(path, text);
    return Promise.resolve();
  },
  rename: (from, to) => {
    renameSync(from, to);
    return Promise.resolve();
  },
  exists: (path) => Promise.resolve(existsSync(path)),
};
