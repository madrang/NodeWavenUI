/**
 * The settings store of one workspace: a thin reader and writer over one storage backend.
 * A storage setup builds the backend (see `storage-setups.ts`).
 * The provider settings (which carry the API key) are the stored values.
 */

import type { StorageBackend } from '../storage/storage.js';
import { isMcpEndpoints, type McpEndpoints } from '../shared/mcp-endpoints.js';
import { isPermissionRule, type PermissionRule } from '../shared/permissions.js';
import { EMPTY_SHARED_STORAGES, isSharedStoragesRecord, type SharedStoragesRecord } from './storage-shares.js';
import {
  emptyProviderRegistry,
  isProviderRegistry,
  isProviderSettings,
  type ProviderAccount,
  type ProviderRegistry,
  type ProviderSettings,
} from '../shared/workspace.js';

const PROVIDER_SETTINGS_KEY = 'provider-settings';
const PROVIDER_ACCOUNTS_KEY = 'provider-accounts';
const PERMISSION_RULES_KEY = 'permission-rules';
const MCP_HOST_TOKEN_KEY = 'mcp-host-token';
const MCP_ENDPOINTS_KEY = 'mcp-endpoints';
const SHARED_STORAGES_KEY = 'shared-storages';
const THEME_KEY = 'theme';
const FRAME_MODE_KEY = 'window-frame';
const MINIMUM_MCP_TOKEN_LENGTH = 16;
const MAXIMUM_MCP_TOKEN_LENGTH = 256;

/** Builds a display label for a migrated account out of its endpoint host. */
function labelForBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).host;
    return host.length > 0 ? host : 'Provider';
  } catch {
    return 'Provider';
  }
}

/** Reads and writes the provider settings of one workspace. */
export class WorkspaceSettingsStore {
  private readonly backend: StorageBackend;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /**
   * Reads the provider registry. A missing registry migrates the old single-provider record into one account.
   *
   * @returns The registry. An empty registry carries no account.
   * @throws StorageError when the password is wrong or the store fails.
   */
  async loadProviderRegistry(): Promise<ProviderRegistry> {
    const raw = await this.backend.get(PROVIDER_ACCOUNTS_KEY);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isProviderRegistry(parsed)) {
          return parsed;
        }
        console.warn('[NodeWavenUI] the stored provider registry carries an invalid shape. It is ignored.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the stored provider registry is damaged and ignored: ${message}`);
      }
    }
    const legacy = await this.loadLegacyProviderSettings();
    if (legacy === null) {
      return emptyProviderRegistry();
    }
    const account: ProviderAccount = {
      id: crypto.randomUUID(),
      label: labelForBaseUrl(legacy.baseUrl),
      baseUrl: legacy.baseUrl,
      apiKey: legacy.apiKey,
      models: [legacy.model],
    };
    console.info('[NodeWavenUI] the provider settings moved into the provider registry as one account.');
    return { accounts: [account], defaultProviderId: account.id, defaultModel: legacy.model };
  }

  /**
   * Writes the provider registry.
   *
   * @param registry The registry to persist.
   * @throws StorageError when the store fails.
   */
  async saveProviderRegistry(registry: ProviderRegistry): Promise<void> {
    await this.backend.set(PROVIDER_ACCOUNTS_KEY, JSON.stringify(registry));
  }

  /** Reads the old single-provider record, before the registry migration. */
  private async loadLegacyProviderSettings(): Promise<ProviderSettings | null> {
    const raw = await this.backend.get(PROVIDER_SETTINGS_KEY);
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isProviderSettings(parsed)) {
        return parsed;
      }
      console.warn('[NodeWavenUI] the stored provider settings carry an invalid shape. They are ignored.');
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored provider settings are damaged and ignored: ${message}`);
      return null;
    }
  }

  /**
   * Reads the permission rules. A damaged record or an invalid rule entry logs a warning and is skipped.
   *
   * @returns The rules in stored order.
   * @throws StorageError when the store fails.
   */
  async loadPermissionRules(): Promise<readonly PermissionRule[]> {
    const raw = await this.backend.get(PERMISSION_RULES_KEY);
    if (raw === null) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored permission rules are damaged and ignored: ${message}`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.warn('[NodeWavenUI] the stored permission rules carry an invalid shape. They are ignored.');
      return [];
    }
    return parsed.filter((entry): entry is PermissionRule => {
      if (isPermissionRule(entry)) {
        return true;
      }
      console.warn('[NodeWavenUI] one stored permission rule carries an invalid shape. It is skipped.');
      return false;
    });
  }

  /**
   * Writes the permission rules.
   *
   * @param rules The rules to persist, in evaluation order.
   * @throws StorageError when the store fails.
   */
  async savePermissionRules(rules: readonly PermissionRule[]): Promise<void> {
    await this.backend.set(PERMISSION_RULES_KEY, JSON.stringify(rules));
  }

  /**
   * Reads the MCP host access token. A damaged record logs a warning and clears to null.
   *
   * @returns The token, or null when the store holds none.
   * @throws StorageError when the store fails.
   */
  async loadMcpHostToken(): Promise<string | null> {
    const raw = await this.backend.get(MCP_HOST_TOKEN_KEY);
    if (raw === null) {
      return null;
    }
    if (raw.length < MINIMUM_MCP_TOKEN_LENGTH || raw.length > MAXIMUM_MCP_TOKEN_LENGTH) {
      console.warn('[NodeWavenUI] the stored MCP host token carries an invalid shape. A new token is generated.');
      return null;
    }
    return raw;
  }

  /**
   * Writes the MCP host access token, so the token survives launches.
   *
   * @param token The token to persist.
   * @throws StorageError when the store fails.
   */
  async saveMcpHostToken(token: string): Promise<void> {
    await this.backend.set(MCP_HOST_TOKEN_KEY, token);
  }

  /**
   * Reads the MCP client endpoints. A damaged record logs a warning and clears to the empty list.
   *
   * @returns The endpoints in stored order.
   * @throws StorageError when the store fails.
   */
  async loadMcpEndpoints(): Promise<McpEndpoints> {
    const raw = await this.backend.get(MCP_ENDPOINTS_KEY);
    if (raw === null) {
      return { endpoints: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored MCP endpoints are damaged and ignored: ${message}`);
      return { endpoints: [] };
    }
    if (isMcpEndpoints(parsed)) {
      return parsed;
    }
    console.warn('[NodeWavenUI] the stored MCP endpoints carry an invalid shape. They are ignored.');
    return { endpoints: [] };
  }

  /**
   * Writes the MCP client endpoints.
   *
   * @param endpoints The endpoints to persist, in stored order.
   * @throws StorageError when the store fails.
   */
  async saveMcpEndpoints(endpoints: McpEndpoints): Promise<void> {
    await this.backend.set(MCP_ENDPOINTS_KEY, JSON.stringify(endpoints));
  }

  /**
   * Reads the storage sharing record. A damaged record logs a warning and clears to the empty record.
   *
   * @returns The sharing record. Nothing is shared by default.
   * @throws StorageError when the store fails.
   */
  async loadSharedStorages(): Promise<SharedStoragesRecord> {
    const raw = await this.backend.get(SHARED_STORAGES_KEY);
    if (raw === null) {
      return EMPTY_SHARED_STORAGES;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored storage sharing is damaged and ignored: ${message}`);
      return EMPTY_SHARED_STORAGES;
    }
    if (isSharedStoragesRecord(parsed)) {
      return parsed;
    }
    console.warn('[NodeWavenUI] the stored storage sharing carries an invalid shape. It is ignored.');
    return EMPTY_SHARED_STORAGES;
  }

  /**
   * Writes the storage sharing record.
   *
   * @param record The sharing record to persist.
   * @throws StorageError when the store fails.
   */
  async saveSharedStorages(record: SharedStoragesRecord): Promise<void> {
    await this.backend.set(SHARED_STORAGES_KEY, JSON.stringify(record));
  }

  /**
   * Reads the chosen theme of the workspace.
   *
   * @returns The stored theme id, or null when the store holds none. The theme registry applies the default.
   * @throws StorageError when the store fails.
   */
  async loadThemePreference(): Promise<string | null> {
    return this.backend.get(THEME_KEY);
  }

  /**
   * Writes the chosen theme of the workspace.
   *
   * @param themeId The theme id to persist.
   * @throws StorageError when the store fails.
   */
  async saveThemePreference(themeId: string): Promise<void> {
    await this.backend.set(THEME_KEY, themeId);
  }

  /**
   * Reads the chosen window frame mode of the workspace.
   *
   * @returns The stored frame mode id, or null when the store holds none. The frame mode registry applies the default.
   * @throws StorageError when the store fails.
   */
  async loadFrameModePreference(): Promise<string | null> {
    return this.backend.get(FRAME_MODE_KEY);
  }

  /**
   * Writes the chosen window frame mode of the workspace.
   *
   * @param modeId The frame mode id to persist.
   * @throws StorageError when the store fails.
   */
  async saveFrameModePreference(modeId: string): Promise<void> {
    await this.backend.set(FRAME_MODE_KEY, modeId);
  }
}
