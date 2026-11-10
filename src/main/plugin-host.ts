/**
 * The main-side plugin host, first slice. The sandboxed renderer has no require, so the plugin
 * entries load here with the Node require of the main process. The entry setup registers into a
 * collector, and only the registrations the bridge can carry cross back: the harness documents.
 * Registrations that hold functions — providers, storage setups, system prompt sources — stay
 * unsupported until the host grows a proxy for them.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as vm from 'node:vm';
import type { BridgePluginEntry } from '../shared/bridge.js';

/** The registry surface the entry registers into: the collector keeps what the bridge can carry. */
interface CollectorRegistry {
  registerProvider(provider: unknown): void;
  registerStorage(backend: unknown): void;
  registerStorageSetup(setup: unknown): void;
  registerSystemPromptSetup(setup: unknown): void;
  registerHarnessDoc(doc: unknown): void;
}

/** The descriptor shape one plugin entry's exports must carry. */
function hasDescriptorShape(
  value: unknown,
): value is { id: string; setup: (registry: CollectorRegistry) => void; platforms?: readonly string[] } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const descriptor = value as Record<string, unknown>;
  const platforms = descriptor.platforms;
  const platformsValid =
    platforms === undefined || (Array.isArray(platforms) && platforms.every((platform) => typeof platform === 'string'));
  return (
    typeof descriptor.id === 'string' &&
    descriptor.id.length > 0 &&
    typeof descriptor.setup === 'function' &&
    platformsValid
  );
}

/** Builds the collector registry of one load: the unsupported registrations throw, the rest cross. */
function collectorOf(harnessDocs: unknown[]): CollectorRegistry {
  return {
    registerProvider: () => {
      throw new Error('registerProvider holds functions the bridge cannot carry yet.');
    },
    registerStorage: () => {
      throw new Error('registerStorage holds functions the bridge cannot carry yet.');
    },
    registerStorageSetup: () => {
      throw new Error('registerStorageSetup holds functions the bridge cannot carry yet.');
    },
    registerSystemPromptSetup: () => {
      throw new Error('registerSystemPromptSetup holds functions the bridge cannot carry yet.');
    },
    registerHarnessDoc: (doc: unknown) => {
      harnessDocs.push(doc);
    },
  };
}

/**
 * Reads and runs one CommonJS entry under the CommonJS wrapper.
 * The app root carries `"type": "module"`, so a plain require of a `.js` entry treats it as an ES
 * module and its `module.exports` fails. The wrapper restores the CommonJS semantics, and the
 * require resolves relative to the plugin folder.
 *
 * @param modulePath The CommonJS module to run.
 * @returns The exports the module set.
 * @throws Error when the file does not read or the module throws.
 */
function runCommonJsEntry(modulePath: string): unknown {
  const source = readFileSync(modulePath, 'utf-8');
  const module = { exports: {} as unknown };
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`;
  const wrapper = vm.runInThisContext(wrapped, { filename: modulePath }) as (
    exports: unknown,
    require: NodeRequire,
    module: { exports: unknown },
    filename: string,
    dirname: string,
  ) => void;
  wrapper(module.exports, createRequire(modulePath), module, modulePath, dirname(modulePath));
  return module.exports;
}

/**
 * Loads one plugin entry and collects its registrations.
 *
 * @param modulePath The CommonJS module to load.
 * @returns The entry id, the platform filter result, and the harness documents it registered.
 * @throws Error when the module fails to load or exports no plugin descriptor.
 */
export function loadPluginEntry(modulePath: string): BridgePluginEntry {
  let exports: unknown;
  try {
    exports = runCommonJsEntry(modulePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load the plugin module "${modulePath}": ${message}`, { cause: error });
  }
  const record = exports as { default?: unknown } | null;
  const descriptor = hasDescriptorShape(record?.default) ?
    record.default :
    hasDescriptorShape(exports) ?
      exports :
      null;
  if (!descriptor) {
    throw new Error('The plugin module exports no PluginDescriptor.');
  }
  if (descriptor.platforms && !descriptor.platforms.includes(process.platform)) {
    return { id: descriptor.id, platforms: descriptor.platforms, skipped: true, harnessDocs: [] };
  }
  const harnessDocs: unknown[] = [];
  descriptor.setup(collectorOf(harnessDocs));
  return {
    id: descriptor.id,
    ...(descriptor.platforms ? { platforms: descriptor.platforms } : {}),
    skipped: false,
    harnessDocs,
  };
}
