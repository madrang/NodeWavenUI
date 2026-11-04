/**
 * Plugin management for user-loaded providers and storage backends.
 * A plugin is a CommonJS module that exports a PluginDescriptor, directly or as its default export.
 * The NW.js page context loads plugin modules through its Node require global, so a plugin can reach native modules and the filesystem.
 * That reach is what enables platform-specific plugins, for example a DPAPI storage backend on Windows.
 */

import { isInferenceProvider, type InferenceProvider } from './providers/provider.js';
import { currentPlatform, nodeRequire } from './shared/node-access.js';
import { isRecord } from './shared/records.js';
import { isStorageBackend, type StorageBackend } from './storage/storage.js';

/** What a plugin module exports. CommonJS form: `module.exports = descriptor`. */
export interface PluginDescriptor {
  /** Unique identifier of the plugin. */
  readonly id: string;
  /**
   * The process.platform values the plugin runs on, for example "win32" or "linux".
   * Undefined means every platform.
   */
  readonly platforms?: readonly string[];
  /** Registers the contributions of the plugin with the manager. */
  readonly setup: (registry: PluginRegistry) => void;
}

/** The surface a plugin uses to contribute providers, storage backends, and system prompt sources. */
export interface PluginRegistry {
  /** Registers one inference provider. */
  registerProvider(provider: InferenceProvider): void;
  /** Registers one storage backend. */
  registerStorage(backend: StorageBackend): void;
  /** Registers one storage setup, which lists in the wizard dropdown. */
  registerStorageSetup(setup: StorageSetup): void;
  /** Registers one system prompt source, which lists in the chat menu. */
  registerSystemPromptSetup(setup: SystemPromptSetup): void;
  /** Registers one harness document, which the agent surfaces serve as a resource. */
  registerHarnessDoc(doc: HarnessDocSetup): void;
}

/** One harness document a plugin contributes: an agent-facing resource that lives with the plugin. */
export interface HarnessDocSetup {
  /** The resource URI both agent surfaces serve, for example `harness:///nodewavenui/selftest.md`. */
  readonly uri: string;
  /** The file to fetch, absolute from the app root, for example `/plugins/selftest/selftest.md`. */
  readonly file: string;
  readonly name: string;
  readonly description: string;
}

/** Options for opening the backend of one workspace. */
export interface StorageOpenOptions {
  readonly directoryPath: string;
  /** The non-secret configuration kept in the workspace marker. */
  readonly config: unknown;
  /** The password, for setups that need one. */
  readonly password?: string;
}

/** One option of a selection field in a plugin UI definition. */
export interface PluginFieldOption {
  readonly value: string;
  readonly label: string;
  /** False blocks the selection of this option. The default is true. */
  readonly enabled?: boolean;
}

/** One field of a plugin UI definition. */
export interface PluginFieldDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: 'text' | 'password' | 'select';
  readonly placeholder?: string;
  readonly prefill?: string;
  /** The options of a select field. */
  readonly options?: readonly PluginFieldOption[];
}

/** The assembled configuration of a storage setup. */
export interface StorageConfiguration {
  /** The non-secret configuration kept in the workspace marker. */
  readonly config: unknown;
  /** The password the setup protects its store with, or null. */
  readonly password: string | null;
}

/** What a storage plugin contributes: an entry in the wizard dropdown and a way to build configured backends. */
export interface StorageSetup {
  /** Unique identifier of the setup, kept in the workspace marker. */
  readonly id: string;
  /** Label shown in the dropdown. */
  readonly label: string;
  /** True when the setup asks the user for a password at open time. */
  readonly needsPassword: boolean;
  /**
   * The configuration UI definition of the setup.
   * The app renders it wherever the user configures storage, so the wizard and the settings pane show the same fields.
   */
  readonly fields?: readonly PluginFieldDefinition[];
  /**
   * Validates the field values and assembles the configuration.
   *
   * @param values The values of the UI definition fields, by field id.
   * @returns The configuration, or an error message for the user.
   */
  readonly readConfiguration: (values: Readonly<Record<string, string>>) => StorageConfiguration | string;
  /** Opens the backend for a workspace. */
  readonly open: (options: StorageOpenOptions) => StorageBackend;
}

/** The context one system prompt source builds its text from. */
export interface SystemPromptContext {
  /** The absolute path of the workspace directory. */
  readonly workspacePath: string;
}

/** What a system prompt plugin contributes: an entry in the chat menu and a way to build its text. */
export interface SystemPromptSetup {
  /** Unique identifier of the source, kept with the chat that binds it. */
  readonly id: string;
  /** Label shown in the chat menu and as the title of the collapsed prompt. */
  readonly label: string;
  /**
   * Builds the prompt text of one chat.
   *
   * @param context The workspace facts of the chat.
   * @returns The prompt text. An empty text binds no system message.
   */
  readonly build: (context: SystemPromptContext) => Promise<string>;
}

/** Error the plugin manager throws on failure. */
export class PluginError extends Error {
  /**
   * @param message What failed, in a sentence a user can act on.
   * @param options The optional standard cause of this error.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginError';
  }
}

/**
 * Checks that a value satisfies the PluginDescriptor shape.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries an id string, a setup function, and a valid platform list.
 */
function hasDescriptorShape(value: unknown): value is PluginDescriptor {
  if (!isRecord(value)) {
    return false;
  }
  const platforms = value.platforms;
  const platformsValid =
    platforms === undefined ||
    (Array.isArray(platforms) && platforms.every((platform) => typeof platform === 'string'));
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.setup === 'function' &&
    platformsValid
  );
}

const FIELD_KINDS = ['text', 'password', 'select'];

/**
 * Checks that a value satisfies the PluginFieldDefinition shape.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries a field id, a label, and a known kind.
 */
function isPluginFieldDefinition(value: unknown): value is PluginFieldDefinition {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.label === 'string' &&
    typeof value.kind === 'string' &&
    FIELD_KINDS.includes(value.kind)
  );
}

/**
 * Checks that a value satisfies the StorageSetup shape.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the setup strings, the password flag, the configuration reader, the open function, and a valid UI definition.
 */
function isStorageSetup(value: unknown): value is StorageSetup {
  if (!isRecord(value)) {
    return false;
  }
  const fields = value.fields;
  const fieldsValid =
    fields === undefined || (Array.isArray(fields) && fields.every((field) => isPluginFieldDefinition(field)));
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    typeof value.needsPassword === 'boolean' &&
    typeof value.readConfiguration === 'function' &&
    typeof value.open === 'function' &&
    fieldsValid
  );
}

/**
 * Checks that a value satisfies the SystemPromptSetup shape.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the id and label strings and the build function.
 */
function isSystemPromptSetup(value: unknown): value is SystemPromptSetup {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    typeof value.build === 'function'
  );
}

/**
 * Checks that a value satisfies the HarnessDocSetup shape.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the four non-empty strings.
 */
function isHarnessDocSetup(value: unknown): value is HarnessDocSetup {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.uri === 'string' &&
    value.uri.length > 0 &&
    typeof value.file === 'string' &&
    value.file.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.description === 'string' &&
    value.description.length > 0
  );
}

/**
 * Reads the plugin descriptor out of a module's exports.
 *
 * @param exports The module exports. It can have any type.
 * @returns The descriptor.
 * @throws PluginError when the exports carry no descriptor.
 */
function readDescriptor(exports: unknown): PluginDescriptor {
  if (isRecord(exports) && hasDescriptorShape(exports.default)) {
    return exports.default;
  }
  if (hasDescriptorShape(exports)) {
    return exports;
  }
  throw new PluginError('The plugin module exports no PluginDescriptor.');
}

/** Loads plugins and hands out the contributions they registered. */
export class PluginManager implements PluginRegistry {
  private readonly providers = new Map<string, InferenceProvider>();
  private readonly storages = new Map<string, StorageBackend>();
  private readonly storageSetups = new Map<string, StorageSetup>();
  private readonly systemPromptSetups = new Map<string, SystemPromptSetup>();
  private readonly harnessDocs = new Map<string, HarnessDocSetup>();
  private readonly plugins = new Map<string, PluginDescriptor>();
  private readonly reservedHarnessDocUris: readonly string[];

  /**
   * @param reservedHarnessDocUris The uris built-in harness documents already claim.
   * The harness doc registration rejects them, so a plugin never shadows a built-in resource.
   * Empty for managers outside the workspace window, which serve no harness documents.
   */
  constructor(reservedHarnessDocUris: readonly string[] = []) {
    this.reservedHarnessDocUris = [...reservedHarnessDocUris];
  }

  /**
   * Registers one inference provider.
   *
   * @param provider The provider. Values from plugin modules are validated against the contract shape.
   * @throws PluginError when the value does not satisfy the contract or the id is taken.
   */
  registerProvider(provider: unknown): void {
    if (!isInferenceProvider(provider)) {
      throw new PluginError('The provider does not satisfy the InferenceProvider shape.');
    }
    if (this.providers.has(provider.id)) {
      throw new PluginError(`A provider with the id "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Registers one storage backend.
   *
   * @param backend The backend. Values from plugin modules are validated against the contract shape.
   * @throws PluginError when the value does not satisfy the contract or the id is taken.
   */
  registerStorage(backend: unknown): void {
    if (!isStorageBackend(backend)) {
      throw new PluginError('The backend does not satisfy the StorageBackend shape.');
    }
    if (this.storages.has(backend.id)) {
      throw new PluginError(`A storage backend with the id "${backend.id}" is already registered.`);
    }
    this.storages.set(backend.id, backend);
  }

  /**
   * Registers one storage setup for the wizard dropdown.
   *
   * @param setup The setup. Values from plugin modules are validated against the setup shape.
   * @throws PluginError when the value does not satisfy the shape or the id is taken.
   */
  registerStorageSetup(setup: unknown): void {
    if (!isStorageSetup(setup)) {
      throw new PluginError('The setup does not satisfy the StorageSetup shape.');
    }
    if (this.storageSetups.has(setup.id)) {
      throw new PluginError(`A storage setup with the id "${setup.id}" is already registered.`);
    }
    this.storageSetups.set(setup.id, setup);
  }

  /**
   * Registers one system prompt source for the chat menu.
   *
   * @param setup The source. Values from plugin modules are validated against the setup shape.
   * @throws PluginError when the value does not satisfy the shape or the id is taken.
   */
  registerSystemPromptSetup(setup: unknown): void {
    if (!isSystemPromptSetup(setup)) {
      throw new PluginError('The setup does not satisfy the SystemPromptSetup shape.');
    }
    if (this.systemPromptSetups.has(setup.id)) {
      throw new PluginError(`A system prompt setup with the id "${setup.id}" is already registered.`);
    }
    this.systemPromptSetups.set(setup.id, setup);
  }

  /**
   * Registers one harness document, which the agent surfaces serve as a resource.
   *
   * @param doc The document. Values from plugin modules are validated against the setup shape.
   * @throws PluginError when the value does not satisfy the shape, the uri is taken, or the uri belongs to a built-in document.
   */
  registerHarnessDoc(doc: unknown): void {
    if (!isHarnessDocSetup(doc)) {
      throw new PluginError('The setup does not satisfy the HarnessDocSetup shape.');
    }
    if (this.reservedHarnessDocUris.includes(doc.uri)) {
      throw new PluginError(`The uri "${doc.uri}" belongs to a built-in harness document.`);
    }
    if (this.harnessDocs.has(doc.uri)) {
      throw new PluginError(`A harness document with the uri "${doc.uri}" is already registered.`);
    }
    this.harnessDocs.set(doc.uri, doc);
  }

  /**
   * Loads one plugin module and registers its contributions.
   * A plugin that declares another platform loads nothing and reports no error.
   *
   * @param modulePath The CommonJS module to load, or any id the require resolves.
   * @throws PluginError when require is missing, the module fails to load, the exports carry no descriptor, or the plugin id is taken.
   */
  async loadPlugin(modulePath: string): Promise<void> {
    const require = nodeRequire();
    if (require === null) {
      throw new PluginError('Plugin loading needs the Node require of the NW.js page context.');
    }
    let exports: unknown;
    try {
      exports = require(modulePath);
    } catch (error) {
      throw new PluginError(`Could not load the plugin module "${modulePath}".`, { cause: error });
    }
    const descriptor = readDescriptor(exports);
    if (this.plugins.has(descriptor.id)) {
      throw new PluginError(`A plugin with the id "${descriptor.id}" is already loaded.`);
    }
    if (descriptor.platforms !== undefined && !descriptor.platforms.includes(currentPlatform())) {
      return;
    }
    this.plugins.set(descriptor.id, descriptor);
    descriptor.setup(this);
  }

  /**
   * Loads every plugin module of one directory.
   * A module whose name does not end in ".js" is skipped, and so are dotfiles.
   * A module that fails to load logs a warning and does not stop the other modules.
   *
   * @param directory The directory to scan.
   * @throws PluginError when require is missing or the directory cannot be read.
   */
  async loadPluginsFromDirectory(directory: string): Promise<void> {
    const require = nodeRequire();
    if (require === null) {
      throw new PluginError('Plugin loading needs the Node require of the NW.js page context.');
    }
    let entries: readonly string[];
    try {
      const fs = require('fs') as { readdirSync?: (dir: string) => string[] };
      if (typeof fs.readdirSync !== 'function') {
        throw new Error('fs.readdirSync is not available.');
      }
      entries = fs.readdirSync(directory);
    } catch (error) {
      throw new PluginError(`Could not read the plugin directory "${directory}".`, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.endsWith('.js') || entry.startsWith('.')) {
        continue;
      }
      const modulePath = `${directory.replace(/[\\/]+$/, '')}/${entry}`;
      try {
        await this.loadPlugin(modulePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] skipping the plugin "${entry}": ${message}`);
      }
    }
  }

  /**
   * Looks up one provider by id.
   *
   * @param id The provider id.
   * @returns The provider, or undefined when no plugin registered it.
   */
  getProvider(id: string): InferenceProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Looks up one storage backend by id.
   *
   * @param id The backend id.
   * @returns The backend, or undefined when no plugin registered it.
   */
  getStorage(id: string): StorageBackend | undefined {
    return this.storages.get(id);
  }

  /**
   * Looks up one storage setup by id.
   *
   * @param id The setup id.
   * @returns The setup, or undefined when nothing registered it.
   */
  getStorageSetup(id: string): StorageSetup | undefined {
    return this.storageSetups.get(id);
  }

  /** Lists every registered storage backend. */
  listStorage(): readonly StorageBackend[] {
    return [...this.storages.values()];
  }

  /** Lists every registered storage setup, in registration order. */
  listStorageSetups(): readonly StorageSetup[] {
    return [...this.storageSetups.values()];
  }

  /**
   * Looks up one system prompt source by id.
   *
   * @param id The source id.
   * @returns The source, or undefined when nothing registered it.
   */
  getSystemPromptSetup(id: string): SystemPromptSetup | undefined {
    return this.systemPromptSetups.get(id);
  }

  /** Lists every registered system prompt source, in registration order. */
  listSystemPromptSetups(): readonly SystemPromptSetup[] {
    return [...this.systemPromptSetups.values()];
  }

  /** Lists every registered harness document, in registration order. */
  listHarnessDocs(): readonly HarnessDocSetup[] {
    return [...this.harnessDocs.values()];
  }

  /** Lists every loaded plugin descriptor. */
  listPlugins(): readonly PluginDescriptor[] {
    return [...this.plugins.values()];
  }
}
