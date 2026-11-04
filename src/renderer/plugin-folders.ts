/**
 * The plugin folder system: the scan of the app `plugins/` directory, the manifest guard,
 * the SHA-256 integrity digest, and the controller the settings pane drives.
 * Every plugin folder carries a `plugin.json` manifest, and a plugin loads only while its
 * stored enable flag is on and the folder digest still matches the stored digest.
 */

import type { PluginManager } from '../plugins.js';

/** The fs slice the plugin folder system reads through. */
export interface PluginFolderFs {
  readdirSync(path: string): readonly string[];
  readFileSync(path: string, encoding: 'utf-8'): string;
  readFileSync(path: string): Uint8Array;
  statSync(path: string): { isDirectory(): boolean };
}

/** The manifest of one plugin folder: the `plugin.json` file. */
export interface PluginFolderManifest {
  /** Unique id of the plugin, the same id the loaded module descriptor carries. */
  readonly id: string;
  /** The name the settings pane shows. */
  readonly name: string;
  /** The module file the app loads, relative to the plugin folder. */
  readonly entry: string;
  /** The version the settings pane shows. */
  readonly version?: string;
  /** One sentence on what the plugin adds. */
  readonly description?: string;
}

/** The stored state of one plugin folder, kept in the `plugin-folders` record. */
export interface StoredPluginFolder {
  readonly enabled: boolean;
  /** The SHA-256 digest of the folder content at enable time. */
  readonly digest?: string;
}

/** The record the workspace settings hold, keyed by plugin folder name. */
export type StoredPluginFolders = Record<string, StoredPluginFolder>;

/** The store IO the controller reads and writes through. */
export interface PluginFolderStore {
  load(): Promise<StoredPluginFolders>;
  save(record: StoredPluginFolders): Promise<void>;
}

/** One plugin folder the scan accepted. */
export interface PluginFolder {
  /** The folder name under `plugins/`. */
  readonly folder: string;
  /** The absolute path of the folder. */
  readonly folderPath: string;
  readonly manifest: PluginFolderManifest;
}

/** One folder the scan rejected, with the reason the settings pane shows. */
export interface SkippedPluginFolder {
  readonly folder: string;
  readonly reason: string;
}

/** The result of one scan of the `plugins/` directory. */
export interface PluginFolderScan {
  readonly plugins: readonly PluginFolder[];
  readonly skipped: readonly SkippedPluginFolder[];
}

/** True when an entry path stays inside the plugin folder: relative, no parent hop. */
function isSafeEntry(entry: string): boolean {
  if (entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
    return false;
  }
  return entry.split(/[\\/]+/).every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/**
 * Checks that a value satisfies the manifest shape.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the id, name, and a safe entry path.
 */
export function isPluginFolderManifest(value: unknown): value is PluginFolderManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.entry === 'string' &&
    isSafeEntry(candidate.entry) &&
    (candidate.version === undefined || typeof candidate.version === 'string') &&
    (candidate.description === undefined || typeof candidate.description === 'string')
  );
}

/** Reads one stored plugin folder record. Returns disabled on an invalid shape. */
function readStoredPluginFolder(value: unknown): StoredPluginFolder {
  if (typeof value !== 'object' || value === null) {
    return { enabled: false };
  }
  const candidate = value as Record<string, unknown>;
  return {
    enabled: candidate.enabled === true,
    ...(typeof candidate.digest === 'string' ? { digest: candidate.digest } : {}),
  };
}

/**
 * Scans the `plugins/` directory of the app root.
 * A subfolder without a valid `plugin.json` comes back as skipped, with the reason.
 *
 * @param appRoot The absolute path of the app root directory.
 * @param fs The filesystem slice to read through.
 * @returns The accepted plugin folders and the skipped ones.
 */
export function scanPluginFolders(appRoot: string, fs: PluginFolderFs): PluginFolderScan {
  const plugins: PluginFolder[] = [];
  const skipped: SkippedPluginFolder[] = [];
  let names: readonly string[];
  try {
    names = fs.readdirSync(`${appRoot.replace(/[\\/]+$/, '')}/plugins`);
  } catch {
    return { plugins, skipped };
  }
  for (const folder of names) {
    if (folder.startsWith('.')) {
      continue;
    }
    const folderPath = `${appRoot.replace(/[\\/]+$/, '')}/plugins/${folder}`;
    try {
      if (!fs.statSync(folderPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(fs.readFileSync(`${folderPath}/plugin.json`, 'utf-8'));
    } catch {
      skipped.push({ folder, reason: 'plugin.json is missing or holds no valid JSON.' });
      continue;
    }
    if (!isPluginFolderManifest(manifest)) {
      skipped.push({ folder, reason: 'plugin.json breaks the manifest shape.' });
      continue;
    }
    plugins.push({ folder, folderPath, manifest });
  }
  return { plugins, skipped };
}

/** Collects the relative paths of every file under one folder, in sorted order. */
function collectFilePaths(fs: PluginFolderFs, directory: string, prefix: string, paths: string[]): void {
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith('.')) {
      continue;
    }
    const path = `${directory}/${name}`;
    const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
    if (fs.statSync(path).isDirectory()) {
      collectFilePaths(fs, path, relative, paths);
      continue;
    }
    paths.push(relative);
  }
  paths.sort();
}

/**
 * Computes the SHA-256 digest of one plugin folder.
 * The digest covers every file, framed as the relative path, a zero byte, and the file bytes,
 * with the files in sorted path order, so the digest is stable across platforms and write orders.
 *
 * @param folderPath The absolute path of the plugin folder.
 * @param fs The filesystem slice to read through.
 * @returns The digest as lowercase hex.
 */
export async function hashPluginFolder(folderPath: string, fs: PluginFolderFs): Promise<string> {
  const paths: string[] = [];
  collectFilePaths(fs, folderPath, '', paths);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const path of paths) {
    const nameBytes = encoder.encode(path);
    const zero = Uint8Array.of(0);
    const fileBytes = fs.readFileSync(`${folderPath}/${path}`);
    chunks.push(nameBytes, zero, fileBytes, zero);
    length += nameBytes.length + 1 + fileBytes.length + 1;
  }
  const whole = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', whole);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The state of one plugin folder the settings pane renders. */
export interface PluginFolderState {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly enabled: boolean;
  /** The SHA-256 digest of the folder content, computed from the current files. */
  readonly digest?: string;
  /** The stored digest that no longer matches the folder. The settings show it beside the new one on a reset. */
  readonly previousDigest?: string;
  /** What the app did with the folder: the load state or the reason it stayed out. */
  readonly status: 'disabled' | 'loaded' | 'reset' | 'failed' | 'skipped';
  readonly detail: string;
}

/** Owns the plugin folders: the scan result, the stored flags, and the loading through the plugin manager. */
export class PluginFolderController {
  private readonly states = new Map<string, PluginFolderState>();

  /**
   * @param plugins The plugin manager the enabled folders load through.
   * @param store The workspace settings IO for the enable flags and digests.
   * @param appRoot The absolute path of the app root directory.
   * @param fs The filesystem slice, or null outside NW.js, where no scan runs.
   */
  constructor(
    private readonly plugins: PluginManager,
    private readonly store: PluginFolderStore,
    private readonly appRoot: string,
    private readonly fs: PluginFolderFs | null,
  ) {}

  /**
   * Scans the plugin folders and loads every enabled one that passes the integrity gate.
   * A folder whose digest changed resets to disabled, so changed code never loads by itself.
   */
  async initialize(): Promise<void> {
    if (this.fs === null) {
      return;
    }
    const scan = scanPluginFolders(this.appRoot, this.fs);
    const stored = await this.store.load();
    for (const folder of scan.plugins) {
      // Every accepted folder gets its digest computed, so every settings row shows one.
      const digest = await hashPluginFolder(folder.folderPath, this.fs);
      const record = readStoredPluginFolder(stored[folder.folder]);
      if (!record.enabled) {
        this.states.set(folder.manifest.id, this.stateOf(folder, false, 'disabled', '', digest));
        continue;
      }
      if (record.digest !== digest) {
        stored[folder.folder] = { enabled: false };
        await this.store.save(stored);
        this.states.set(
          folder.manifest.id,
          this.stateOf(folder, false, 'reset', 'The folder content changed, so the plugin reset to disabled.', digest, record.digest),
        );
        continue;
      }
      try {
        await this.plugins.loadPlugin(`${folder.folderPath}/${folder.manifest.entry}`);
        this.states.set(folder.manifest.id, this.stateOf(folder, true, 'loaded', '', digest));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.states.set(folder.manifest.id, this.stateOf(folder, true, 'failed', `The plugin failed to load: ${message}`, digest));
      }
    }
    for (const folder of scan.skipped) {
      this.states.set(folder.folder, {
        id: folder.folder,
        name: folder.folder,
        enabled: false,
        status: 'skipped',
        detail: folder.reason,
      });
    }
  }

  /** Lists the plugin folder states for the settings pane, scan order first, skipped folders last. */
  list(): readonly PluginFolderState[] {
    return [...this.states.values()];
  }

  /**
   * Enables or disables one plugin folder.
   * Enabling computes the digest, loads the plugin, and stores the flag with the digest.
   * A load failure keeps the flag off. A disable unloads nothing, so an enable of an id the
   * manager already holds skips the load and keeps the live contributions.
   * Disabling stores the flag; loaded contributions leave at the next start.
   *
   * @param id The plugin id of the folder.
   * @param enabled True enables the folder, false disables it.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (this.fs === null) {
      return;
    }
    const scan = scanPluginFolders(this.appRoot, this.fs);
    const folder = scan.plugins.find((candidate) => candidate.manifest.id === id);
    if (!folder) {
      return;
    }
    const stored = await this.store.load();
    if (!enabled) {
      stored[folder.folder] = { enabled: false };
      await this.store.save(stored);
      const digest = await hashPluginFolder(folder.folderPath, this.fs);
      this.states.set(id, this.stateOf(folder, false, 'disabled', 'Loaded contributions leave at the next start.', digest));
      return;
    }
    const digest = await hashPluginFolder(folder.folderPath, this.fs);
    // The manager already holding the id means the plugin loaded earlier in the session and a
    // disable unloaded nothing. A second load would throw on the duplicate id, so the flag alone moves.
    if (!this.plugins.listPlugins().some((plugin) => plugin.id === id)) {
      try {
        await this.plugins.loadPlugin(`${folder.folderPath}/${folder.manifest.entry}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.states.set(id, this.stateOf(folder, false, 'failed', `The plugin failed to load: ${message}`, digest));
        return;
      }
    }
    stored[folder.folder] = { enabled: true, digest };
    await this.store.save(stored);
    this.states.set(id, this.stateOf(folder, true, 'loaded', '', digest));
  }

  private stateOf(
    folder: PluginFolder,
    enabled: boolean,
    status: PluginFolderState['status'],
    detail: string,
    digest?: string,
    previousDigest?: string,
  ): PluginFolderState {
    return {
      id: folder.manifest.id,
      name: folder.manifest.name,
      ...(folder.manifest.version !== undefined ? { version: folder.manifest.version } : {}),
      ...(folder.manifest.description !== undefined ? { description: folder.manifest.description } : {}),
      enabled,
      ...(digest !== undefined ? { digest } : {}),
      ...(previousDigest !== undefined ? { previousDigest } : {}),
      status,
      detail,
    };
  }
}
