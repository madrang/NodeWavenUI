/**
 * The settings pane of the workspace window: every section the gear opens in the center
 * workspace. The view owns the settings state of the workspace — the provider registry, the
 * MCP endpoints, the storage sharing, the known paths, and the workspace preferences — and
 * persists every change through the settings store.
 */

import type { ThinkingLevel } from '../providers/provider.js';
import type { StorageSetup } from './plugins.js';
import type { McpEndpoint, McpEndpoints } from '../shared/mcp-endpoints.js';
import { endpointLabelCollisions, sanitizeEndpointLabel } from '../shared/mcp-endpoints.js';
import { PATH_RULE_MODES, type PathRule, type PathRuleMode } from '../shared/permissions.js';
import type { ModelEntry, ProviderAccount, ProviderRegistry } from '../shared/workspace.js';
import { emptyProviderRegistry } from '../shared/workspace.js';
import { PROVIDER_PRESETS } from '../shared/provider-presets/index.js';
import { readBridge, type NodeWavenBridge } from '../shared/bridge.js';
import { agentToolRule, type AgentTool } from './agent-tools.js';
import type { McpClientSurface } from './mcp-client-adapter.js';
import type { McpHostHandle } from '../shared/window-tools.js';
import type { PermissionGate } from './permission-gate.js';
import { PluginFieldGroup } from './plugin-fields.js';
import { requireElement } from './dom.js';
import type { WorkspaceSettingsStore } from '../storage/settings-store.js';
import {
  EMPTY_SHARED_STORAGES,
  type StorageShareRegistry,
  type SharedStoragesRecord,
  type StorageAccess,
  type SharedStorageEntry,
} from './storage-shares.js';
import { applyTheme, resolveThemeId, THEMES } from './theme.js';
import { FRAME_MODES, resolveFrameMode } from './frame-mode.js';
import { currentLanguage, LANGUAGES, LANGUAGE_MIRROR_KEY, translateMessage } from './locale/index.js';
import { log } from './logger.js';
import type { PluginFolderController } from './plugin-folders.js';

/** The settings label of each path rule mode. */
const PATH_RULE_LABELS: Readonly<Record<PathRuleMode, string>> = {
  allow: 'Free read and write',
  'ask-write': 'Ask on write',
  ask: 'Ask on read and write',
  deny: 'Deny',
};

/** Splits one command line into the executable and its arguments, honoring double-quoted pieces. */
function splitCommandLine(line: string): { readonly command: string; readonly args: readonly string[] } {
  const parts = line.trim().match(/"([^"]*)"|(\S+)/g) ?? [];
  const pieces = parts.map((part) =>
    part.length >= 2 && part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
  return { command: pieces[0] ?? '', args: pieces.slice(1) };
}

/** The account the chats use: the chosen default, or the first one. */
export function effectiveDefaultAccount(registry: ProviderRegistry): ProviderAccount | null {
  return registry.accounts.find((account) => account.id === registry.defaultProviderId) ?? registry.accounts[0] ?? null;
}

/** The model the chats use: the chosen default when it belongs to the account, or the account's first. */
export function effectiveDefaultModel(registry: ProviderRegistry, account: ProviderAccount): string | null {
  const wanted = registry.defaultModel;
  if (wanted && account.models.some((model) => model.id === wanted)) {
    return wanted;
  }
  return account.models[0]?.id ?? null;
}

/** Reads the vision flag of one model of an account. An unknown model reads text only. */
export function modelVision(account: ProviderAccount, modelId: string | null): boolean {
  if (!modelId) {
    return false;
  }
  return account.models.find((model) => model.id === modelId)?.vision ?? false;
}

/** The status-bar display name of one model: the id, plus the vision marker when the model sees images. */
export function modelDisplayName(account: ProviderAccount, modelId: string): string {
  return modelVision(account, modelId) ? `${modelId} · vision` : modelId;
}

/** The services and callbacks the settings view works with. The chat reacts to registry changes,
 * and the agent tool listing reads the tool deps of the chat agent. */
export interface SettingsViewDeps {
  onRegistryChange(): void;
  listAgentTools(): readonly AgentTool[];
}

/** Drives the settings pane of the workspace window. */
export class SettingsView {
  private readonly store: WorkspaceSettingsStore;
  private readonly permissionGate: PermissionGate | null;
  private readonly mcpClients: McpClientSurface;
  private readonly storageShares: StorageShareRegistry;
  private readonly storageSetups: readonly StorageSetup[];
  private readonly storageLabel: string;
  private readonly pluginFolders: PluginFolderController;
  private readonly deps: SettingsViewDeps;
  private mcpHost: McpHostHandle | null = null;
  private providerRegistry: ProviderRegistry = emptyProviderRegistry();
  private mcpEndpoints: McpEndpoints = { endpoints: [] };
  private sharedStorages: SharedStoragesRecord = EMPTY_SHARED_STORAGES;
  private pathRuleList: readonly PathRule[] = [];
  /** How many provider rounds one message may spend on tool calls. Null means no limit. */
  private turnLimit: number | null = null;
  /** The default reasoning effort of the chats. Null means the endpoint default. */
  private thinkingDefault: ThinkingLevel | null = null;

  private readonly providerList = requireElement<HTMLElement>('#provider-list');
  private readonly providerAdd = requireElement<HTMLDetailsElement>('#provider-add');
  private readonly providerAddForm = requireElement<HTMLFormElement>('#provider-add-form');
  private readonly providerAddPreset = requireElement<HTMLSelectElement>('#provider-add-preset');
  private readonly providerAddLabel = requireElement<HTMLInputElement>('#provider-add-label');
  private readonly providerAddUrl = requireElement<HTMLInputElement>('#provider-add-url');
  private readonly providerAddKey = requireElement<HTMLInputElement>('#provider-add-key');
  private readonly providerAddSubmit = requireElement<HTMLButtonElement>('#provider-add-submit');
  private readonly providerStatus = requireElement<HTMLElement>('#provider-status');
  private readonly mcpEndpointList = requireElement<HTMLElement>('#mcp-endpoint-list');
  private readonly mcpEndpointAddForm = requireElement<HTMLFormElement>('#mcp-endpoint-add-form');
  private readonly mcpAddLabel = requireElement<HTMLInputElement>('#mcp-add-label');
  private readonly mcpAddKind = requireElement<HTMLSelectElement>('#mcp-add-kind');
  private readonly mcpAddUrl = requireElement<HTMLInputElement>('#mcp-add-url');
  private readonly mcpAddToken = requireElement<HTMLInputElement>('#mcp-add-token');
  private readonly mcpAddCommand = requireElement<HTMLInputElement>('#mcp-add-command');
  private readonly mcpAddMode = requireElement<HTMLSelectElement>('#mcp-add-mode');
  private readonly mcpAddUrlField = requireElement<HTMLElement>('#mcp-add-url-field');
  private readonly mcpAddTokenField = requireElement<HTMLElement>('#mcp-add-token-field');
  private readonly mcpAddCommandField = requireElement<HTMLElement>('#mcp-add-command-field');
  private readonly mcpEndpointStatus = requireElement<HTMLElement>('#mcp-endpoint-status');
  private readonly shareList = requireElement<HTMLElement>('#storage-share-list');
  private readonly shareAdd = requireElement<HTMLDetailsElement>('#storage-share-add');
  private readonly shareAddForm = requireElement<HTMLFormElement>('#storage-share-add-form');
  private readonly shareLabel = requireElement<HTMLInputElement>('#storage-share-label');
  private readonly shareSetup = requireElement<HTMLSelectElement>('#storage-share-setup');
  private readonly shareFields = requireElement<HTMLElement>('#storage-share-fields');
  private readonly shareAccess = requireElement<HTMLSelectElement>('#storage-share-access');
  private readonly shareStatus = requireElement<HTMLElement>('#storage-share-status');
  private readonly agentToolList = requireElement<HTMLElement>('#agent-tool-list');
  private readonly pluginFolderList = requireElement<HTMLElement>('#plugin-folder-list');

  /**
   * @param store The settings store of the workspace.
   * @param permissionGate The permission gate of the workspace, or null before one exists.
   * @param mcpClients The MCP client manager of the workspace.
   * @param storageShares The storage sharing registry of the workspace.
   * @param storageSetups The registered storage setups, for the add form.
   * @param storageLabel The display label of the storage the workspace uses.
   * @param pluginFolders The plugin folder controller.
   * @param deps The services and callbacks of the chat.
   */
  constructor(
    store: WorkspaceSettingsStore,
    permissionGate: PermissionGate | null,
    mcpClients: McpClientSurface,
    storageShares: StorageShareRegistry,
    storageSetups: readonly StorageSetup[],
    storageLabel: string,
    pluginFolders: PluginFolderController,
    deps: SettingsViewDeps,
  ) {
    this.store = store;
    this.permissionGate = permissionGate;
    this.mcpClients = mcpClients;
    this.storageShares = storageShares;
    this.storageSetups = storageSetups;
    this.storageLabel = storageLabel;
    this.pluginFolders = pluginFolders;
    this.deps = deps;
  }

  /** The provider registry the chats resolve their connection from. */
  get registry(): ProviderRegistry {
    return this.providerRegistry;
  }

  /** The known paths the file tools check every access against. */
  get pathRules(): readonly PathRule[] {
    return this.pathRuleList;
  }

  /** How many provider rounds one message may spend on tool calls. Null means no limit. */
  get agentTurnLimit(): number | null {
    return this.turnLimit;
  }

  /** The default reasoning effort of the chats. Null means the endpoint default. */
  get agentThinkingDefault(): ThinkingLevel | null {
    return this.thinkingDefault;
  }

  /**
   * Loads the settings records, applies them to the services, and wires every section of the pane.
   *
   * @param mcpHost The running MCP host handle, or null when the host stays off.
   */
  async initialize(mcpHost: McpHostHandle | null): Promise<void> {
    this.mcpHost = mcpHost;
    requireElement<HTMLElement>('#workspace-storage-mode').textContent = translateMessage('settings', 'storage', 'mode', { label: this.storageLabel });
    try {
      this.providerRegistry = await this.store.loadProviderRegistry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`could not read the provider registry: ${message}`);
    }
    this.syncProviderCors();
    try {
      this.mcpEndpoints = await this.store.loadMcpEndpoints();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`could not read the MCP endpoints: ${message}`);
    }
    try {
      this.sharedStorages = await this.store.loadSharedStorages();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`could not read the storage sharing: ${message}`);
    }
    try {
      this.pathRuleList = await this.store.loadPathRules();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`could not read the path rules: ${message}`);
    }
    void this.mcpClients.applyEndpoints(this.mcpEndpoints);
    this.mcpClients.subscribe(() => {
      this.renderMcpEndpoints();
      this.renderAgentTools();
    });
    this.storageShares.applyRecord(this.sharedStorages);
    await this.initializeThemeControls();
    await this.initializeFrameControls();
    await this.initializeLanguageControls();
    await this.initializeAgentTurnControls();
    this.initializeMcpHostSection();
    this.initializeMcpEndpointsSection();
    this.initializeKnownPathsSection();
    this.initializeStorageShareSection();
    void this.initializeRemoteSection();
  }

  /**
   * Seeds the agent tool defaults and renders the sections that need the permission gate ready:
   * the agent tools, the plugin folders, and the provider cards.
   */
  async start(): Promise<void> {
    await this.seedAgentToolDefaults();
    // The direct render covers a launch that seeds nothing and fires no gate or connection event.
    this.renderAgentTools();
    this.renderPluginFolders();
    this.initializeProviderSection();
  }

  /** Reads the bridge of the workspace window for the core requests of the remote section. */
  private core(): NodeWavenBridge | null {
    return readBridge();
  }

  /** Wires the remote control section: the server toggle, the pairing token, the QR, and the password. */
  private async initializeRemoteSection(): Promise<void> {
    const bridge = this.core();
    if (!bridge) {
      return;
    }
    const enabledField = requireElement<HTMLInputElement>('#remote-enabled');
    const portField = requireElement<HTMLInputElement>('#remote-port');
    const bindField = requireElement<HTMLSelectElement>('#remote-bind');
    const plainHttpField = requireElement<HTMLInputElement>('#remote-plain-http');
    const closeBehaviorField = requireElement<HTMLSelectElement>('#close-behavior');
    const originLine = requireElement<HTMLElement>('#remote-origin');
    const tokenField = requireElement<HTMLInputElement>('#remote-token');
    const qrImage = requireElement<HTMLImageElement>('#remote-qr-image');
    const passwordField = requireElement<HTMLInputElement>('#remote-password');
    type RemoteConfig = {
      enabled: boolean;
      port: number;
      bind: string;
      allowPlainHttp: boolean;
      origin: string | null;
      /** The addresses the host may bind, from the latest answer. */
      interfaces?: string[];
    };
    let interfaces: readonly string[] = [];
    const fillInterfaces = (list: readonly string[]): void => {
      interfaces = list;
      bindField.replaceChildren(
        ...list.map((address) => {
          const option = document.createElement('option');
          option.value = address;
          option.textContent = address === '0.0.0.0' ? translateMessage('settings', 'remoteControl', 'bindAll') : address;
          return option;
        }),
      );
    };
    const apply = (config: RemoteConfig): void => {
      enabledField.checked = config.enabled;
      portField.value = String(config.port);
      plainHttpField.checked = config.allowPlainHttp;
      fillInterfaces(config.interfaces ?? interfaces);
      bindField.value = config.bind;
      originLine.textContent = config.enabled ? `The phone page answers on ${config.origin ?? 'the configured address'}.` : 'The server stays off.';
    };
    try {
      apply((await bridge.core.request('remote.config.get')) as RemoteConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      originLine.textContent = `The remote section failed: ${message}`;
      return;
    }
    const save = async (): Promise<void> => {
      const config = {
        enabled: enabledField.checked,
        port: Number.parseInt(portField.value, 10),
        bind: bindField.value,
        allowPlainHttp: plainHttpField.checked,
      };
      if (!Number.isInteger(config.port) || config.port <= 0 || config.port >= 65536) {
        originLine.textContent = 'The port needs a number between 1 and 65535.';
        return;
      }
      try {
        const answer = (await bridge.core.request('remote.config.save', config)) as { origin?: string; interfaces?: string[] };
        apply({
          ...config,
          origin: answer?.origin ?? null,
          ...(answer?.interfaces ? { interfaces: answer.interfaces } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        originLine.textContent = `The configuration could not be saved: ${message}`;
      }
    };
    enabledField.addEventListener('change', () => {
      void save();
    });
    plainHttpField.addEventListener('change', () => {
      void save();
    });
    portField.addEventListener('change', () => {
      void save();
    });
    bindField.addEventListener('change', () => {
      void save();
    });
    try {
      closeBehaviorField.value = await this.store.loadCloseBehavior();
    } catch {
      closeBehaviorField.value = 'quit';
    }
    closeBehaviorField.addEventListener('change', () => {
      const behavior = closeBehaviorField.value === 'tray' ? 'tray' : 'quit';
      void this.store.saveCloseBehavior(behavior).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the close behavior could not be saved: ${message}`);
      });
    });
    requireElement<HTMLButtonElement>('#remote-token-show').addEventListener('click', () => {
      void bridge.core
        .request('remote.token.show')
        .then((token) => {
          tokenField.value = typeof token === 'string' ? token : '';
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          originLine.textContent = `The pairing token could not be read: ${message}`;
        });
    });
    requireElement<HTMLButtonElement>('#remote-token-renew').addEventListener('click', () => {
      void bridge.core
        .request('remote.token.renew')
        .then((token) => {
          tokenField.value = typeof token === 'string' ? token : '';
          originLine.textContent = 'The pairing token was renewed. Pair the phone again with the new token.';
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          originLine.textContent = `The pairing token could not be renewed: ${message}`;
        });
    });
    requireElement<HTMLButtonElement>('#remote-token-copy').addEventListener('click', () => {
      void bridge.core
        .request('remote.token.show')
        .then((token) => (typeof token === 'string' ? navigator.clipboard.writeText(token) : Promise.reject(new Error('No token.'))))
        .then(() => {
          tokenField.value = 'Copied.';
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log.settings.warning(`the remote token could not be copied: ${message}`);
        });
    });
    requireElement<HTMLButtonElement>('#remote-qr').addEventListener('click', () => {
      // The second press hides the code again, so the pane keeps its size while nobody pairs.
      if (!qrImage.hidden) {
        qrImage.hidden = true;
        return;
      }
      void bridge.core
        .request('remote.qr')
        .then((image) => {
          if (typeof image === 'string') {
            qrImage.src = image;
            qrImage.hidden = false;
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          originLine.textContent = `The QR code failed: ${message}`;
        });
    });
    requireElement<HTMLButtonElement>('#remote-password-set').addEventListener('click', () => {
      const password = passwordField.value;
      if (password.length < 8) {
        originLine.textContent = 'The remote password needs at least eight characters.';
        return;
      }
      void bridge.core
        .request('remote.password.set', { password })
        .then(() => {
          passwordField.value = '';
          originLine.textContent = 'The remote password was set.';
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          originLine.textContent = `The remote password could not be set: ${message}`;
        });
    });
    requireElement<HTMLButtonElement>('#remote-password-clear').addEventListener('click', () => {
      void bridge.core
        .request('remote.password.clear')
        .then(() => {
          passwordField.value = '';
          originLine.textContent = 'The remote password was cleared. The token stays the only credential.';
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          originLine.textContent = `The remote password could not be cleared: ${message}`;
        });
    });
  }
  /** Wires the MCP host section. The section stays hidden while the host stays off. */
  private initializeMcpHostSection(): void {
    const section = requireElement<HTMLFieldSetElement>('#mcp-host-section');
    const host = this.mcpHost;
    if (!host) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    requireElement<HTMLElement>('#mcp-host-endpoint').textContent = host.endpoint;
    const tokenField = requireElement<HTMLInputElement>('#mcp-host-token');
    requireElement<HTMLButtonElement>('#mcp-token-show').addEventListener('click', () => {
      tokenField.value = host.readAccessToken();
    });
    requireElement<HTMLButtonElement>('#mcp-token-copy').addEventListener('click', () => {
      void navigator.clipboard
        .writeText(host.readAccessToken())
        .then(() => {
          tokenField.value = host.readAccessToken();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log.settings.warning(`the MCP host token could not be copied: ${message}`);
        });
    });
  }

  /** Renders and wires the known paths section: one row per path rule, the add form below. */
  private initializeKnownPathsSection(): void {
    const list = requireElement<HTMLDivElement>('#known-path-list');
    const form = requireElement<HTMLFormElement>('#known-path-add');
    const nameInput = requireElement<HTMLInputElement>('#known-path-name');
    const input = requireElement<HTMLInputElement>('#known-path-input');
    const modeSelect = requireElement<HTMLSelectElement>('#known-path-mode');
    const render = (): void => {
      list.replaceChildren();
      if (this.pathRuleList.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'status';
        empty.textContent = 'No path is known. Reads ask, and every write proposes a patch for review.';
        list.append(empty);
        return;
      }
      for (const rule of this.pathRuleList) {
        list.append(this.buildKnownPathRow(rule, render));
      }
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const path = input.value.trim().replace(/^\/+|\/+$/g, '');
      if (path.length === 0 || path === '.') {
        return;
      }
      const name = nameInput.value.trim();
      const mode = PATH_RULE_MODES.includes(modeSelect.value as PathRuleMode) ? (modeSelect.value as PathRuleMode) : 'ask';
      // A second add of the same path changes its name and mode instead of stacking a duplicate.
      if (this.pathRuleList.some((rule) => rule.path === path)) {
        this.pathRuleList = this.pathRuleList.map((rule) => (rule.path === path ? { path, name, mode } : rule));
      } else {
        this.pathRuleList = [...this.pathRuleList, { path, name, mode }];
      }
      nameInput.value = '';
      input.value = '';
      void this.savePathRules();
      render();
    });
    render();
  }

  /** One known path row: the editable name, the path, its mode select, and the remove action. */
  private buildKnownPathRow(rule: PathRule, render: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'known-path';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'known-path-name';
    name.value = rule.name;
    name.placeholder = 'Name';
    name.title = 'The name of the path, shown to the agent beside its access';
    name.addEventListener('change', () => {
      const next = name.value.trim();
      this.pathRuleList = this.pathRuleList.map((candidate) =>
        candidate === rule ? { path: candidate.path, name: next, mode: candidate.mode } : candidate,
      );
      void this.savePathRules();
    });
    const label = document.createElement('span');
    label.className = 'known-path-label';
    label.textContent = rule.path;
    const modeSelect = document.createElement('select');
    modeSelect.title = 'The access rule of the path';
    for (const mode of PATH_RULE_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = PATH_RULE_LABELS[mode];
      modeSelect.append(option);
    }
    modeSelect.value = rule.mode;
    modeSelect.addEventListener('change', () => {
      const next = modeSelect.value as PathRuleMode;
      this.pathRuleList = this.pathRuleList.map((candidate) =>
        candidate === rule ? { path: candidate.path, name: candidate.name, mode: next } : candidate,
      );
      void this.savePathRules();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      this.pathRuleList = this.pathRuleList.filter((candidate) => candidate !== rule);
      void this.savePathRules();
      render();
    });
    row.append(name, label, modeSelect, remove);
    return row;
  }

  /** Persists the known paths. A failure keeps the working list and logs. */
  private async savePathRules(): Promise<void> {
    try {
      await this.store.savePathRules(this.pathRuleList);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`could not save the path rules: ${message}`);
    }
  }

  private initializeMcpEndpointsSection(): void {
    this.mcpAddKind.addEventListener('change', () => {
      this.updateMcpAddFormShape();
    });
    this.mcpEndpointAddForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.addMcpEndpointFromForm();
    });
    this.updateMcpAddFormShape();
    this.renderMcpEndpoints();
  }

  /** The add form shows the fields of the selected transport kind. */
  private updateMcpAddFormShape(): void {
    const http = this.mcpAddKind.value === 'http';
    this.mcpAddUrlField.hidden = !http;
    this.mcpAddTokenField.hidden = !http;
    this.mcpAddCommandField.hidden = http;
  }

  private showMcpEndpointStatus(message: string, isError: boolean): void {
    this.mcpEndpointStatus.textContent = message;
    this.mcpEndpointStatus.className = isError ? 'status error' : 'status';
    this.mcpEndpointStatus.hidden = false;
  }

  private addMcpEndpointFromForm(): void {
    const label = this.mcpAddLabel.value.trim();
    if (label.length === 0) {
      this.showMcpEndpointStatus('The label is required.', true);
      return;
    }
    const mode = this.mcpAddMode.value as McpEndpoint['mode'];
    const isHttp = this.mcpAddKind.value === 'http';
    const token = this.mcpAddToken.value.trim();
    if (isHttp && this.mcpAddUrl.value.trim().length === 0) {
      this.showMcpEndpointStatus('The endpoint URL is required.', true);
      return;
    }
    const commandLine = splitCommandLine(this.mcpAddCommand.value);
    if (!isHttp && commandLine.command.length === 0) {
      this.showMcpEndpointStatus('The command is required.', true);
      return;
    }
    const transport: McpEndpoint['transport'] = isHttp ?
      { kind: 'http', url: this.mcpAddUrl.value.trim(), ...(token.length > 0 ? { token } : {}) } :
      {
        kind: 'stdio',
        command: commandLine.command,
        ...(commandLine.args.length > 0 ? { args: commandLine.args } : {}),
      };
    const endpoint: McpEndpoint = {
      id: crypto.randomUUID(),
      label,
      transport,
      mode,
    };
    // Two native labels that sanitize to one tool prefix would name their tools alike, so the
    // second set answers no call. The add form refuses the collision before it lands.
    const collision = endpointLabelCollisions([...this.mcpEndpoints.endpoints, endpoint]).get(endpoint.id);
    if (collision) {
      this.showMcpEndpointStatus(collision, true);
      return;
    }
    this.mcpAddLabel.value = '';
    this.mcpAddUrl.value = '';
    this.mcpAddToken.value = '';
    this.mcpAddCommand.value = '';
    this.persistMcpEndpoints({ endpoints: [...this.mcpEndpoints.endpoints, endpoint] }, 'Endpoint added.');
  }

  /** Stores the next endpoint list, applies it to the connections, and re-renders the cards. */
  private persistMcpEndpoints(next: McpEndpoints, successText: string): void {
    void (async () => {
      // The carry runs to completion first: it reads the live tool names of the old connections,
      // so its rule moves finish before the new connections replace them.
      await this.carryToolRulesOverRename(this.mcpEndpoints, next);
      this.mcpEndpoints = next;
      await this.mcpClients.applyEndpoints(next);
      this.renderMcpEndpoints();
      await this.store
        .saveMcpEndpoints(next)
        .then(() => {
          this.showMcpEndpointStatus(successText, false);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.showMcpEndpointStatus(message, true);
        });
    })();
  }

  /** Renders one card per endpoint, disabled ones included, with the live connection state. */
  private renderMcpEndpoints(): void {
    this.mcpEndpointList.replaceChildren();
    if (this.mcpEndpoints.endpoints.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No MCP endpoint is configured. Add one below.';
      this.mcpEndpointList.append(empty);
      return;
    }
    const states = new Map(this.mcpClients.listServers().map((state) => [state.id, state]));
    for (const endpoint of this.mcpEndpoints.endpoints) {
      this.mcpEndpointList.append(this.buildMcpEndpointCard(endpoint, states.get(endpoint.id) ?? null));
    }
  }

  /** One endpoint card: label, transport, live state, the mode dropdown, and the remove action. */
  private buildMcpEndpointCard(
    endpoint: McpEndpoint,
    state: { state: string; error: string | null } | null,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mcp-endpoint';
    const title = document.createElement('span');
    title.className = 'mcp-endpoint-label';
    title.textContent = endpoint.label;
    const transport = document.createElement('span');
    transport.className = 'mcp-endpoint-transport';
    transport.textContent =
      endpoint.transport.kind === 'http' ? endpoint.transport.url : `stdio: ${endpoint.transport.command}`;
    const stateText = document.createElement('span');
    stateText.className = `mcp-endpoint-state ${state?.state ?? 'dormant'}`;
    stateText.textContent =
      !state ?
        'disabled' :
        state.state === 'error' && state.error ?
          `error: ${state.error}` :
          state.state;
    const modeSelect = document.createElement('select');
    modeSelect.className = 'mcp-endpoint-mode';
    for (const [value, label] of [
      ['native', 'Native'],
      ['preloaded', 'Preloaded'],
      ['none', 'None'],
      ['disabled', 'Disabled'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modeSelect.append(option);
    }
    modeSelect.value = endpoint.mode;
    modeSelect.addEventListener('change', () => {
      const nextMode = modeSelect.value as McpEndpoint['mode'];
      this.persistMcpEndpoints(
        {
          endpoints: this.mcpEndpoints.endpoints.map((candidate) =>
            candidate.id === endpoint.id ? { ...candidate, mode: nextMode } : candidate,
          ),
        },
        'Mode saved.',
      );
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      this.persistMcpEndpoints(
        { endpoints: this.mcpEndpoints.endpoints.filter((candidate) => candidate.id !== endpoint.id) },
        'Endpoint removed.',
      );
    });
    card.append(title, transport, stateText, modeSelect, remove);
    return card;
  }

  /** Wires the storage sharing section: the settings storage row, the shared cards, and the add form. */
  private initializeStorageShareSection(): void {
    this.shareSetup.replaceChildren();
    for (const setup of this.storageSetups) {
      const option = document.createElement('option');
      option.value = setup.id;
      option.textContent = setup.label;
      this.shareSetup.append(option);
    }
    this.shareSetup.addEventListener('change', () => {
      this.mountShareFields();
    });
    this.shareAddForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.addSharedStorageFromForm();
    });
    this.mountShareFields();
    this.renderStorageShares();
  }

  /** Mounts the setup fields of the selected storage setup into the add form. */
  private mountShareFields(): void {
    const setup = this.storageSetups.find((candidate) => candidate.id === this.shareSetup.value);
    if (!setup || !setup.fields) {
      this.shareFields.replaceChildren();
      this.shareFieldGroup = null;
      this.shareAddForm.dataset.setupId = setup ? setup.id : '';
      return;
    }
    this.shareFieldGroup = PluginFieldGroup.mount(this.shareFields, setup.fields);
    this.shareAddForm.dataset.setupId = setup.id;
  }

  private shareFieldGroup: PluginFieldGroup | null = null;

  private showShareStatus(message: string, isError: boolean): void {
    this.shareStatus.textContent = message;
    this.shareStatus.className = isError ? 'status error' : 'status';
    this.shareStatus.hidden = false;
  }

  private addSharedStorageFromForm(): void {
    const label = this.shareLabel.value.trim();
    if (label.length === 0) {
      this.showShareStatus('The label is required.', true);
      return;
    }
    const setup = this.storageSetups.find((candidate) => candidate.id === this.shareAddForm.dataset.setupId);
    if (!setup) {
      this.showShareStatus('Pick a storage kind first.', true);
      return;
    }
    const uriId = sanitizeEndpointLabel(label);
    if (this.sharedStorages.storages.some((entry) => entry.uriId === uriId)) {
      this.showShareStatus(`The storage id "${uriId}" is taken. Pick another label.`, true);
      return;
    }
    const values = this.shareFieldGroup?.readValues() ?? {};
    const configuration = setup.readConfiguration(values);
    if (typeof configuration === 'string') {
      this.showShareStatus(configuration, true);
      return;
    }
    const entry: SharedStorageEntry = {
      id: crypto.randomUUID(),
      setupId: setup.id,
      label,
      uriId,
      config: configuration.config,
      password: configuration.password,
      access: this.shareAccess.value === 'readonly' ? 'readonly' : 'none',
    };
    this.shareLabel.value = '';
    this.persistSharedStorages(
      { settingsAccess: this.sharedStorages.settingsAccess, storages: [...this.sharedStorages.storages, entry] },
      'Storage added.',
    );
  }

  /** Stores the next sharing record, applies it, and re-renders the cards. */
  private persistSharedStorages(next: SharedStoragesRecord, successText: string): void {
    this.sharedStorages = next;
    this.storageShares.applyRecord(next);
    this.renderStorageShares();
    void this.store
      .saveSharedStorages(next)
      .then(() => {
        this.showShareStatus(successText, false);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.showShareStatus(message, true);
      });
  }

  /** Renders the settings storage row and one card per shared storage. */
  private renderStorageShares(): void {
    this.shareList.replaceChildren();
    const settingsRow = document.createElement('div');
    settingsRow.className = 'mcp-endpoint';
    const settingsLabel = document.createElement('span');
    settingsLabel.className = 'mcp-endpoint-label';
    settingsLabel.textContent = 'Settings storage';
    const settingsId = document.createElement('span');
    settingsId.className = 'mcp-endpoint-transport';
    settingsId.textContent = this.storageShares.settingsBackendId;
    const settingsAccess = this.buildShareAccessSelect(this.sharedStorages.settingsAccess, (access) => {
      this.persistSharedStorages({ settingsAccess: access, storages: this.sharedStorages.storages }, 'Access saved.');
    });
    settingsRow.append(settingsLabel, settingsId, document.createTextNode('chat agent:'), settingsAccess);
    this.shareList.append(settingsRow);
    const states = this.storageShares.states();
    if (states.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No extra storage is shared. The settings storage stays unshared by default.';
      this.shareList.append(empty);
      return;
    }
    for (const state of states) {
      const card = document.createElement('div');
      card.className = 'mcp-endpoint';
      const label = document.createElement('span');
      label.className = 'mcp-endpoint-label';
      label.textContent = state.label;
      const transport = document.createElement('span');
      transport.className = 'mcp-endpoint-transport';
      transport.textContent = `${state.uriId} · ${state.setupId}${state.error ? ` · error: ${state.error}` : state.open ? ' · open' : ''}`;
      const access = this.buildShareAccessSelect(state.access, (nextAccess) => {
        this.persistSharedStorages(
          {
            settingsAccess: this.sharedStorages.settingsAccess,
            storages: this.sharedStorages.storages.map((entry) =>
              entry.id === state.id ? { ...entry, access: nextAccess } : entry,
            ),
          },
          'Access saved.',
        );
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        this.persistSharedStorages(
          {
            settingsAccess: this.sharedStorages.settingsAccess,
            storages: this.sharedStorages.storages.filter((entry) => entry.id !== state.id),
          },
          'Storage removed.',
        );
      });
      card.append(label, transport, access, remove);
      this.shareList.append(card);
    }
  }

  /** The access dropdown of one shared storage or the settings storage. */
  private buildShareAccessSelect(current: StorageAccess, onChange: (access: StorageAccess) => void): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'mcp-endpoint-mode';
    const notShared = document.createElement('option');
    notShared.value = 'none';
    notShared.textContent = 'Not shared';
    const readOnly = document.createElement('option');
    readOnly.value = 'readonly';
    readOnly.textContent = 'Read-only';
    select.append(notShared, readOnly);
    select.value = current;
    select.addEventListener('change', () => {
      onChange(select.value === 'readonly' ? 'readonly' : 'none');
    });
    return select;
  }

  /** Seeds the tool defaults once per workspace: the two trusted built-ins, read and evaluate, start allowed. */
  private async seedAgentToolDefaults(): Promise<void> {
    const gate = this.permissionGate;
    if (!gate) {
      return;
    }
    try {
      if (await this.store.loadAgentToolDefaults()) {
        return;
      }
      for (const name of ['read', 'evaluate']) {
        // A rule that already governs the tool holds the user's choice, so a repeated seeding adds nothing.
        if (agentToolRule(name, gate.listRules())) {
          continue;
        }
        await gate.addRule({
          id: crypto.randomUUID(),
          enabled: true,
          principal: 'agent',
          resource: 'tool',
          actions: [name],
          effect: 'allow',
        });
      }
      await this.store.saveAgentToolDefaults(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the agent tool defaults could not be seeded: ${message}`);
    }
  }

  /** Renders the agent tools section: one group head per origin, one row per tool with its state. */
  renderAgentTools(): void {
    this.agentToolList.replaceChildren();
    const gate = this.permissionGate;
    const rules = gate?.listRules() ?? [];
    const tools = this.deps.listAgentTools();
    if (tools.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No tool is available to the chat agent.';
      this.agentToolList.append(empty);
      return;
    }
    let group = '';
    for (const tool of tools) {
      const origin = this.toolOriginLabel(tool.name);
      if (origin !== group) {
        group = origin;
        const head = document.createElement('p');
        head.className = 'agent-tool-group';
        head.textContent = origin;
        this.agentToolList.append(head);
      }
      const row = document.createElement('div');
      row.className = 'mcp-endpoint';
      const name = document.createElement('span');
      name.className = 'mcp-endpoint-label';
      name.textContent = tool.name;
      name.title = tool.description;
      const description = document.createElement('span');
      description.className = 'mcp-endpoint-transport';
      description.textContent =
        tool.description.length > 60 ? `${tool.description.slice(0, 57)}…` : tool.description;
      const state = agentToolRule(tool.name, rules)?.effect ?? 'ask';
      const select = document.createElement('select');
      select.className = 'mcp-endpoint-mode';
      select.title = 'Ask prompts on first use, Allow skips the prompts, Disable hides the tool.';
      for (const [value, label] of [
        ['ask', 'Ask'],
        ['allow', 'Allow'],
        ['deny', 'Disable'],
      ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
      }
      select.value = state === 'allow' ? 'allow' : state === 'deny' ? 'deny' : 'ask';
      select.addEventListener('change', () => {
        const next = select.value === 'allow' ? 'allow' : select.value === 'deny' ? 'deny' : 'ask';
        void this.setAgentToolState(tool.name, next);
      });
      row.append(name, description, select);
      this.agentToolList.append(row);
    }
  }

  /** The group head of one tool: the built-ins, the file tools, the task tools, the command tools,
   * the page tools, or the endpoint label of a native tool. */
  private toolOriginLabel(name: string): string {
    if (name === 'read' || name === 'evaluate') {
      return 'Built-in tools';
    }
    if (name === 'files' || name === 'write') {
      return 'File tools';
    }
    if (name === 'tasks') {
      return 'Task tools';
    }
    if (name === 'run' || name === 'process_output' || name === 'process_stop') {
      return 'Command tools';
    }
    const separator = name.indexOf('.');
    if (separator > 0) {
      const prefix = name.slice(0, separator);
      const endpoint = this.mcpEndpoints.endpoints.find(
        (candidate) => sanitizeEndpointLabel(candidate.label) === prefix,
      );
      return endpoint?.label ?? 'MCP tools';
    }
    return 'Page tools';
  }

  /** Writes the state of one agent tool as its rule: ask removes the rule, allow and deny replace it. */
  private async setAgentToolState(name: string, effect: 'ask' | 'allow' | 'deny'): Promise<void> {
    const gate = this.permissionGate;
    if (!gate) {
      return;
    }
    try {
      const existing = agentToolRule(name, gate.listRules());
      if (existing) {
        await gate.removeRule(existing.id);
      }
      if (effect !== 'ask') {
        await gate.addRule({
          id: existing?.id ?? crypto.randomUUID(),
          enabled: true,
          principal: 'agent',
          resource: 'tool',
          actions: [name],
          effect,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the state of the tool "${name}" could not be saved: ${message}`);
    }
  }

  /** Renders the plugin folder section: one row per folder of the app `plugins/` directory, with its switch. */
  private renderPluginFolders(): void {
    this.pluginFolderList.replaceChildren();
    const states = this.pluginFolders.list();
    if (states.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No plugin folder found under plugins/ of the app.';
      this.pluginFolderList.append(empty);
      return;
    }
    for (const state of states) {
      const row = document.createElement('div');
      row.className = 'mcp-endpoint';
      const name = document.createElement('span');
      name.className = 'mcp-endpoint-label';
      const versionText = state.version ? ` ${state.version}` : '';
      name.textContent = `${state.name}${versionText}`;
      if (state.description) {
        name.title = state.description;
      }
      const detail = document.createElement('span');
      detail.className = 'mcp-endpoint-transport';
      detail.textContent = state.detail.length > 0 ? state.detail : this.pluginFolderStatusText(state.status);
      if (state.status !== 'skipped') {
        const select = document.createElement('select');
        select.className = 'mcp-endpoint-mode';
        select.title = 'Enable loads the plugin and pins its content digest. Disable keeps it out of the next start.';
        for (const [value, label] of [
          ['disabled', 'Disabled'],
          ['enabled', 'Enabled'],
        ] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          select.append(option);
        }
        select.value = state.enabled ? 'enabled' : 'disabled';
        select.addEventListener('change', () => {
          void this.setPluginFolderEnabled(state.id, select.value === 'enabled');
        });
        row.append(name, detail, select);
      } else {
        row.append(name, detail);
      }
      // A reset row shows the stored digest beside the digest of the changed folder, so the
      // cause of the disabled state reads at a glance.
      if (state.previousDigest) {
        row.append(this.pluginDigestLine(`sha256 old ${state.previousDigest}`));
      }
      if (state.digest) {
        row.append(this.pluginDigestLine(`sha256 ${state.previousDigest ? 'new ' : ''}${state.digest}`));
      }
      this.pluginFolderList.append(row);
    }
  }

  /** One SHA-256 line under a plugin folder row. */
  private pluginDigestLine(text: string): HTMLElement {
    const line = document.createElement('div');
    line.className = 'plugin-folder-digest';
    line.textContent = text;
    return line;
  }

  /** The idle status text of one plugin folder state. */
  private pluginFolderStatusText(status: 'disabled' | 'loaded' | 'reset' | 'failed' | 'skipped'): string {
    if (status === 'loaded') {
      return 'Loaded.';
    }
    if (status === 'failed') {
      return 'The plugin failed to load.';
    }
    return 'Off.';
  }

  /** Writes one plugin folder switch through the controller and re-renders the rows. */
  private async setPluginFolderEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pluginFolders.setEnabled(id, enabled);
    this.renderPluginFolders();
  }

  /** Carries the tool rules of an endpoint over a label rename. A rule moves only when every one of its
   * actions maps to a live tool of the endpoint under the new prefix. Anything else stays behind, so the
   * affected tools fall back to ask. */
  private async carryToolRulesOverRename(previous: McpEndpoints, next: McpEndpoints): Promise<void> {
    const gate = this.permissionGate;
    if (!gate) {
      return;
    }
    for (const endpoint of next.endpoints) {
      const old = previous.endpoints.find((candidate) => candidate.id === endpoint.id);
      if (!old || old.label === endpoint.label) {
        continue;
      }
      const oldPrefix = sanitizeEndpointLabel(old.label);
      const newPrefix = sanitizeEndpointLabel(endpoint.label);
      if (oldPrefix === newPrefix) {
        continue;
      }
      const toolNames = this.mcpClients.listServers().find((state) => state.id === endpoint.id)?.toolNames ?? [];
      for (const rule of gate.listRules()) {
        if (rule.resource !== 'tool' || rule.actions === '*') {
          continue;
        }
        const mapped: string[] = [];
        let perfect = rule.actions.length > 0;
        for (const action of rule.actions) {
          const suffix = action.startsWith(`${oldPrefix}.`) ? action.slice(oldPrefix.length + 1) : null;
          if (suffix && toolNames.includes(suffix)) {
            mapped.push(`${newPrefix}.${suffix}`);
          } else {
            perfect = false;
            break;
          }
        }
        if (!perfect) {
          continue;
        }
        try {
          await gate.removeRule(rule.id);
          await gate.addRule({ ...rule, actions: mapped });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.settings.warning(`the tool rules of "${old.label}" could not move to "${endpoint.label}": ${message}`);
        }
      }
    }
  }

  /** Loads the theme of the workspace and wires the theme dropdown of the settings pane. */
  private async initializeThemeControls(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = await this.store.loadThemePreference();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the stored theme could not be read, the default applies: ${message}`);
    }
    const themeId = resolveThemeId(stored);
    applyTheme(themeId);
    const themeSelect = requireElement<HTMLSelectElement>('#theme-select');
    themeSelect.replaceChildren();
    for (const theme of THEMES) {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = theme.label;
      themeSelect.append(option);
    }
    themeSelect.value = themeId;
    themeSelect.addEventListener('change', () => {
      applyTheme(themeSelect.value);
      this.store.saveThemePreference(themeSelect.value).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the theme choice could not be saved: ${message}`);
      });
    });
  }

  /** Loads the frame mode of the workspace and wires the frame dropdown of the settings pane.
   *  NW.js fixes the frame at window creation, so the choice applies the next time the workspace window opens. */
  private async initializeFrameControls(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = await this.store.loadFrameModePreference();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the stored window frame could not be read, the default applies: ${message}`);
    }
    const frameSelect = requireElement<HTMLSelectElement>('#frame-mode-select');
    frameSelect.replaceChildren();
    for (const mode of FRAME_MODES) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label;
      frameSelect.append(option);
    }
    frameSelect.value = resolveFrameMode(stored);
    frameSelect.addEventListener('change', () => {
      this.store.saveFrameModePreference(frameSelect.value).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the window frame choice could not be saved: ${message}`);
      });
    });
  }

  /** Loads the language of the workspace and wires the language dropdown of the settings pane.
   *  The pages read the language at boot, so the choice applies the next time the workspace window opens. */
  private async initializeLanguageControls(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = await this.store.loadLanguagePreference();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the stored language could not be read, the navigator preference applies: ${message}`);
    }
    const languageSelect = requireElement<HTMLSelectElement>('#language-select');
    languageSelect.replaceChildren();
    for (const language of LANGUAGES) {
      const option = document.createElement('option');
      option.value = language.id;
      option.textContent = language.label;
      languageSelect.append(option);
    }
    const known = stored && LANGUAGES.some((language) => language.id === stored) ? stored : null;
    languageSelect.value = known ?? currentLanguage();
    languageSelect.addEventListener('change', () => {
      localStorage.setItem(LANGUAGE_MIRROR_KEY, languageSelect.value);
      this.store.saveLanguagePreference(languageSelect.value).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the language choice could not be saved: ${message}`);
      });
    });
  }

  /** Loads the agent round limit and thinking default of the workspace and wires the dropdowns of the settings pane. */
  private async initializeAgentTurnControls(): Promise<void> {
    try {
      this.turnLimit = await this.store.loadAgentTurnLimit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the stored agent round limit could not be read, no limit applies: ${message}`);
    }
    const turnsSelect = requireElement<HTMLSelectElement>('#agent-turns-select');
    turnsSelect.value = this.turnLimit ? String(this.turnLimit) : '';
    turnsSelect.addEventListener('change', () => {
      const value = Number(turnsSelect.value);
      this.turnLimit = turnsSelect.value === '' ? null : value;
      this.store.saveAgentTurnLimit(this.turnLimit).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the agent round limit could not be saved: ${message}`);
      });
    });
    try {
      this.thinkingDefault = await this.store.loadAgentThinking();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.settings.warning(`the stored agent thinking default could not be read, the endpoint default applies: ${message}`);
    }
    const thinkingSelect = requireElement<HTMLSelectElement>('#agent-thinking-select');
    thinkingSelect.value = this.thinkingDefault ?? '';
    thinkingSelect.addEventListener('change', () => {
      const value = thinkingSelect.value;
      this.thinkingDefault = value === 'low' || value === 'medium' || value === 'high' ? value : null;
      this.store.saveAgentThinking(this.thinkingDefault).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the agent thinking default could not be saved: ${message}`);
      });
    });
  }

  /** Renders the provider cards. The add form is a collapsed disclosure below the list. */
  private initializeProviderSection(): void {
    this.renderProviders();
    this.providerAddForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.addProviderFromForm();
    });
    // The preset list offers every known endpoint; picking one prefills the label and the URL.
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Custom endpoint';
    this.providerAddPreset.append(custom);
    for (const preset of PROVIDER_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = `${preset.label} — ${preset.baseUrl}`;
      this.providerAddPreset.append(option);
    }
    this.providerAddPreset.addEventListener('change', () => {
      const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === this.providerAddPreset.value);
      if (!preset) {
        return;
      }
      if (this.providerAddLabel.value.trim().length === 0) {
        this.providerAddLabel.value = preset.label;
      }
      this.providerAddUrl.value = preset.baseUrl;
      this.updateAddFormState();
    });
    for (const field of [this.providerAddLabel, this.providerAddUrl, this.providerAddKey]) {
      field.addEventListener('input', () => {
        this.updateAddFormState();
      });
    }
    this.updateAddFormState();
  }

  /** The add form submit stays disabled until a field holds input. */
  private updateAddFormState(): void {
    const dirty =
      this.providerAddLabel.value.length > 0 ||
      this.providerAddUrl.value.length > 0 ||
      this.providerAddKey.value.length > 0;
    this.providerAddSubmit.disabled = !dirty;
  }

  /** Rebuilds the provider list: one card per account, or the empty hint. Open cards stay open. */
  private renderProviders(): void {
    const openIds = new Set<string>();
    for (const card of this.providerList.querySelectorAll<HTMLDetailsElement>('details.provider-card[open]')) {
      const id = card.dataset.id;
      if (id) {
        openIds.add(id);
      }
    }
    this.providerList.replaceChildren();
    if (this.providerRegistry.accounts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No provider is configured. Add one below.';
      this.providerList.append(empty);
      return;
    }
    for (const account of this.providerRegistry.accounts) {
      const card = this.buildProviderCard(account);
      if (openIds.has(account.id)) {
        card.open = true;
      }
      this.providerList.append(card);
    }
  }

  /** Registers the base URLs of the registry with the CORS filter of the main process, so the
   * provider fetch of the sandboxed page passes the preflight its endpoints do not answer. */
  private syncProviderCors(): void {
    readBridge()?.workspace
      .allowProviderCors(this.providerRegistry.accounts.map((account) => account.baseUrl))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.settings.warning(`the provider CORS allowlist could not be registered: ${message}`);
      });
  }

  /** Stores the next registry, re-renders the cards, and reports the outcome. */
  private persistRegistry(next: ProviderRegistry, successText: string): void {
    this.providerRegistry = next;
    this.syncProviderCors();
    this.renderProviders();
    this.deps.onRegistryChange();
    void this.store
      .saveProviderRegistry(next)
      .then(() => {
        this.showProviderStatus(successText, false);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.showProviderStatus(message, true);
      });
  }

  private addProviderFromForm(): void {
    const baseUrl = this.providerAddUrl.value.trim();
    if (baseUrl.length === 0) {
      this.showProviderStatus('The endpoint base URL is required.', true);
      return;
    }
    const account: ProviderAccount = {
      id: crypto.randomUUID(),
      label: this.providerAddLabel.value.trim() || 'Provider',
      baseUrl,
      apiKey: this.providerAddKey.value.trim(),
      ...(this.providerAddPreset.value ? { presetId: this.providerAddPreset.value } : {}),
      models: [],
    };
    this.providerAddPreset.value = '';
    this.providerAddLabel.value = '';
    this.providerAddUrl.value = '';
    this.providerAddKey.value = '';
    this.updateAddFormState();
    const isFirst = this.providerRegistry.accounts.length === 0;
    this.persistRegistry(
      {
        accounts: [...this.providerRegistry.accounts, account],
        defaultProviderId: isFirst ? account.id : this.providerRegistry.defaultProviderId,
        defaultModel: this.providerRegistry.defaultModel,
      },
      'Provider added.',
    );
    this.openProviderCard(account.id);
    this.providerAdd.open = false;
  }

  /** Opens the card of one account, e.g. the one the form just added. */
  private openProviderCard(id: string): void {
    const card = this.providerList.querySelector(`details.provider-card[data-id="${CSS.escape(id)}"]`);
    if (card instanceof HTMLDetailsElement) {
      card.open = true;
    }
  }

  /** One collapsible card per account: the summary row names it, the body edits it. */
  private buildProviderCard(account: ProviderAccount): HTMLDetailsElement {
    const card = document.createElement('details') as HTMLDetailsElement;
    card.className = 'provider-card';
    card.dataset.id = account.id;

    const head = document.createElement('summary');
    head.className = 'provider-card-head';
    // The title doubles as the name editor: editing it marks the card dirty, and Save stores the name.
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'provider-title-input';
    titleInput.value = account.label;
    titleInput.spellcheck = false;
    titleInput.title = 'Provider name';
    const modelCount = account.models.length;
    const meta = document.createElement('span');
    meta.className = 'provider-card-meta';
    meta.textContent = modelCount === 1 ? '1 model' : `${modelCount} models`;
    // The default pill lives in the head, so the default provider reads and changes while the card sits collapsed.
    const isDefaultAccount = effectiveDefaultAccount(this.providerRegistry)?.id === account.id;
    const defaultButton = document.createElement('button');
    defaultButton.type = 'button';
    defaultButton.className = 'provider-default-toggle';
    defaultButton.textContent = isDefaultAccount ? 'Default' : 'Set default';
    defaultButton.setAttribute('aria-pressed', String(isDefaultAccount));
    defaultButton.title = 'New chats pick this provider and its current default model.';
    defaultButton.addEventListener('click', (event) => {
      // The click must not open or close the card around the button.
      event.preventDefault();
      // The latched pill stays latched: another provider's pill moves the default.
      if (isDefaultAccount) {
        return;
      }
      this.makeDefaultProvider(account.id);
    });
    head.append(titleInput, meta, defaultButton);

    const body = document.createElement('div');
    body.className = 'provider-card-body';
    const urlField = document.createElement('label');
    urlField.className = 'provider-field';
    urlField.append('Base URL');
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = account.baseUrl;
    urlInput.placeholder = 'https://api.moonshot.ai/v1';
    urlInput.spellcheck = false;
    urlField.append(urlInput);
    const keyField = document.createElement('label');
    keyField.className = 'provider-field';
    keyField.append('API key');
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.value = account.apiKey;
    keyField.append(keyInput);

    const models = document.createElement('div');
    models.className = 'provider-models';
    // Only the default model of the default account reads "In use": every other model offers its Use button,
    // so the default pair can move anywhere, one-model accounts included.
    const defaultAccount = effectiveDefaultAccount(this.providerRegistry);
    const defaultModel = defaultAccount ? effectiveDefaultModel(this.providerRegistry, defaultAccount) : null;
    for (const model of account.models) {
      models.append(this.buildModelRow(account, model, defaultAccount?.id === account.id && model.id === defaultModel));
    }
    if (account.models.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No model on this account. Add one below.';
      models.append(empty);
    }
    const addModelRow = document.createElement('div');
    addModelRow.className = 'provider-add-model';
    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.placeholder = 'kimi-k2.6';
    modelInput.spellcheck = false;
    // The vision flag of the new model latches as a pill and resets after the add.
    const visionToggle = document.createElement('button');
    visionToggle.type = 'button';
    visionToggle.className = 'model-vision-toggle';
    visionToggle.textContent = 'Vision';
    visionToggle.setAttribute('aria-pressed', 'false');
    visionToggle.title = 'The model reads image parts: pasted, dropped, and screenshotted pictures reach it.';
    visionToggle.addEventListener('click', () => {
      visionToggle.setAttribute('aria-pressed', String(visionToggle.getAttribute('aria-pressed') !== 'true'));
    });
    const addModelButton = document.createElement('button');
    addModelButton.type = 'button';
    addModelButton.textContent = 'Add model';
    addModelButton.addEventListener('click', () => {
      this.addModel(account.id, modelInput.value, visionToggle.getAttribute('aria-pressed') === 'true');
      modelInput.value = '';
      visionToggle.setAttribute('aria-pressed', 'false');
    });
    addModelRow.append(modelInput, visionToggle, addModelButton);

    const actions = document.createElement('div');
    actions.className = 'provider-card-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'primary provider-save';
    saveButton.textContent = 'Save';
    saveButton.disabled = true;
    saveButton.addEventListener('click', () => {
      this.saveAccount(account.id, titleInput.value.trim() || 'Provider', urlInput.value.trim(), keyInput.value);
    });
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'provider-remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      this.removeProvider(account.id);
    });
    actions.append(saveButton, removeButton);

    /** The save action enables while an edited value differs from the stored account. */
    const updateSaveState = (): void => {
      const dirty =
        (titleInput.value.trim() || 'Provider') !== account.label ||
        urlInput.value.trim() !== account.baseUrl ||
        keyInput.value !== account.apiKey;
      saveButton.disabled = !dirty;
      card.classList.toggle('dirty', dirty);
    };
    for (const field of [titleInput, urlInput, keyInput]) {
      field.addEventListener('input', updateSaveState);
    }

    body.append(urlField, keyField, models, addModelRow, actions);
    card.append(head, body);
    return card;
  }

  private buildModelRow(account: ProviderAccount, model: ModelEntry, isDefault: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'provider-model';
    const name = document.createElement('span');
    name.className = 'provider-model-name';
    name.textContent = model.id;
    // The vision flag latches as a pill: filled when the model reads images, quiet when it does not.
    const visionToggle = document.createElement('button');
    visionToggle.type = 'button';
    visionToggle.className = 'model-vision-toggle';
    visionToggle.textContent = 'Vision';
    visionToggle.setAttribute('aria-pressed', String(model.vision));
    visionToggle.title = 'The model reads image parts: pasted, dropped, and screenshotted pictures reach it.';
    visionToggle.addEventListener('click', () => {
      this.setModelVision(account.id, model.id, !model.vision);
    });
    // The Use pill latches on the default pair and never unlatches on itself: another Use moves the latch.
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.className = 'model-use';
    useButton.textContent = isDefault ? 'In use' : 'Use';
    useButton.setAttribute('aria-pressed', String(isDefault));
    useButton.addEventListener('click', () => {
      if (isDefault) {
        return;
      }
      this.makeDefault(account.id, model.id);
    });
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'provider-remove';
    removeButton.textContent = '×';
    removeButton.title = `Remove ${model.id}`;
    removeButton.addEventListener('click', () => {
      this.removeModel(account.id, model.id);
    });
    row.append(name, visionToggle, useButton, removeButton);
    return row;
  }

  private accountById(id: string): ProviderAccount | null {
    return this.providerRegistry.accounts.find((account) => account.id === id) ?? null;
  }

  /** Rewrites one account in the registry. */
  private withAccount(id: string, rewrite: (account: ProviderAccount) => ProviderAccount, successText: string): void {
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    this.persistRegistry(
      {
        ...this.providerRegistry,
        accounts: this.providerRegistry.accounts.map((candidate) =>
          candidate.id === id ? rewrite(candidate) : candidate,
        ),
      },
      successText,
    );
  }

  private saveAccount(id: string, label: string, baseUrl: string, apiKey: string): void {
    if (baseUrl.length === 0) {
      this.showProviderStatus('The endpoint base URL is required.', true);
      return;
    }
    this.withAccount(id, (account) => ({ ...account, label, baseUrl, apiKey }), 'Saved.');
  }

  private addModel(id: string, model: string, vision: boolean): void {
    const trimmed = model.trim();
    if (trimmed.length === 0) {
      this.showProviderStatus('The model id is required.', true);
      return;
    }
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    if (account.models.some((candidate) => candidate.id === trimmed)) {
      this.showProviderStatus(`The model "${trimmed}" already exists on this account.`, true);
      return;
    }
    this.persistRegistry(
      {
        accounts: this.providerRegistry.accounts.map((candidate) =>
          candidate.id === id ? { ...candidate, models: [...candidate.models, { id: trimmed, vision }] } : candidate,
        ),
        defaultProviderId: this.providerRegistry.defaultProviderId ?? id,
        defaultModel: this.providerRegistry.defaultModel ?? trimmed,
      },
      'Model added.',
    );
  }

  /** Flips the vision flag of one model. The chats of the model follow at their next send. */
  private setModelVision(id: string, modelId: string, vision: boolean): void {
    this.withAccount(
      id,
      (account) => ({
        ...account,
        models: account.models.map((model) => (model.id === modelId ? { ...model, vision } : model)),
      }),
      vision ? 'Vision on.' : 'Vision off.',
    );
  }

  private removeModel(id: string, model: string): void {
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    const models = account.models.filter((candidate) => candidate.id !== model);
    const wasDefault = this.providerRegistry.defaultModel === model;
    const nextDefault = wasDefault ? (models[0]?.id ?? null) : this.providerRegistry.defaultModel;
    this.persistRegistry(
      {
        ...this.providerRegistry,
        accounts: this.providerRegistry.accounts.map((candidate) =>
          candidate.id === id ? { ...candidate, models } : candidate,
        ),
        defaultModel: nextDefault,
      },
      'Model removed.',
    );
  }

  private makeDefault(id: string, model: string): void {
    this.persistRegistry({ ...this.providerRegistry, defaultProviderId: id, defaultModel: model }, 'Default set.');
  }

  /** Makes one account the default provider, with its effective model as the default model. */
  private makeDefaultProvider(id: string): void {
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    this.persistRegistry(
      {
        ...this.providerRegistry,
        defaultProviderId: id,
        defaultModel: effectiveDefaultModel(this.providerRegistry, account),
      },
      'Default set.',
    );
  }

  private removeProvider(id: string): void {
    const accounts = this.providerRegistry.accounts.filter((account) => account.id !== id);
    const wasDefault = this.providerRegistry.defaultProviderId === id;
    const nextDefaultAccount = wasDefault ? (accounts[0] ?? null) : effectiveDefaultAccount(this.providerRegistry);
    const nextDefaultModel =
      nextDefaultAccount ? effectiveDefaultModel(this.providerRegistry, nextDefaultAccount) : null;
    this.persistRegistry(
      {
        accounts,
        defaultProviderId: nextDefaultAccount?.id ?? null,
        defaultModel: nextDefaultModel,
      },
      'Provider removed.',
    );
  }

  private showProviderStatus(message: string, isError: boolean): void {
    this.providerStatus.textContent = message;
    this.providerStatus.className = isError ? 'status error' : 'status';
    this.providerStatus.hidden = false;
  }
}
