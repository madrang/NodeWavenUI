/**
 * Shared contract for the selected working directory and the workspace settings.
 * Keep this file free of platform dependencies, so that every module can import it.
 */

/** The directory the user selected as the active workspace. */
export interface WorkspaceDirectory {
  /** Directory basename, for example "NodeWavenUI". */
  readonly name: string;
  /** Absolute filesystem path, for example "/home/user/WorkSpace/NodeWavenUI". */
  readonly path: string;
}

/**
 * Checks that a value is a valid WorkspaceDirectory.
 * Use this guard at module boundaries, where values do not come from the type system (DOM events, file objects).
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries a non-empty name and a non-empty path, both strings.
 */
export function isWorkspaceDirectory(value: unknown): value is WorkspaceDirectory {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0
  );
}

/** Marker file that marks a folder as a NodeWavenUI workspace. */
export const WORKSPACE_MARKER_FILE = '.nodewavenui.json';

/** Identity and storage configuration of one workspace, kept in the marker file. */
export interface WorkspaceSettings {
  /** Display name of the workspace. */
  readonly name: string;
  /** Storage setup id, for example "plain" or "password". */
  readonly storageId: string;
  /** Non-secret storage configuration for the setup, for example the encryption suite. */
  readonly storageConfig: unknown;
  /** ISO date and time of the initialization. */
  readonly createdAt: string;
  /**
   * The app version that last wrote this workspace data, in "major.minor.patch" form.
   * The settings migration compares the first two numbers against the running app version,
   * so a patch release never migrates data. A missing version means the data predates versioning.
   */
  readonly version?: string;
}

/**
 * Checks that a value is a valid WorkspaceSettings.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries a name, a storage setup id, and a creation date, all strings.
 */
export function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const versionValid = candidate.version === undefined || typeof candidate.version === 'string';
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.storageId === 'string' &&
    candidate.storageId.length > 0 &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0 &&
    versionValid
  );
}

/** Connection settings of the inference provider, kept in the settings store. */
export interface ProviderSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** One configured provider account with its own model list. */
export interface ProviderAccount {
  /** Stable identifier of the account. */
  readonly id: string;
  /** Display label of the account. */
  readonly label: string;
  /** Base URL of the OpenAI-compatible endpoint. */
  readonly baseUrl: string;
  /** Bearer key of the endpoint. */
  readonly apiKey: string;
  /** The model ids the account offers. */
  readonly models: readonly string[];
}

/** Every configured provider account plus the chat defaults. */
export interface ProviderRegistry {
  readonly accounts: readonly ProviderAccount[];
  /** The account the chats use by default, or null when none is chosen. */
  readonly defaultProviderId: string | null;
  /** The model the chats use by default, or null when none is chosen. */
  readonly defaultModel: string | null;
}

/** The registry without any account. */
export function emptyProviderRegistry(): ProviderRegistry {
  return { accounts: [], defaultProviderId: null, defaultModel: null };
}

/**
 * Checks that a value is a valid ProviderAccount.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the account strings and a model string list.
 */
function isProviderAccount(value: unknown): value is ProviderAccount {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.label === 'string' &&
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.apiKey === 'string' &&
    Array.isArray(candidate.models) &&
    candidate.models.every((model) => typeof model === 'string')
  );
}

/**
 * Checks that a value is a valid ProviderRegistry.
 * Use this guard where the registry arrives without type backing, above all from the persisted record.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries an account list and the default selectors.
 */
export function isProviderRegistry(value: unknown): value is ProviderRegistry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const defaultsValid =
    candidate.defaultProviderId === null ||
    (typeof candidate.defaultProviderId === 'string' && candidate.defaultProviderId.length > 0);
  const defaultModelValid = candidate.defaultModel === null || typeof candidate.defaultModel === 'string';
  return (
    Array.isArray(candidate.accounts) &&
    candidate.accounts.every(isProviderAccount) &&
    defaultsValid &&
    defaultModelValid
  );
}

/**
 * Checks that a value is a valid ProviderSettings.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value carries the three strings of the provider connection.
 */
export function isProviderSettings(value: unknown): value is ProviderSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.apiKey === 'string' &&
    typeof candidate.model === 'string'
  );
}
