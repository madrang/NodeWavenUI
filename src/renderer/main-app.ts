/**
 * The main app screen: a tab bar with a fixed settings tab first, then the chat tabs.
 * The settings pane shows the workspace facts and edits the provider settings.
 * A chat pane sends its conversation through the configured provider and shows the reply.
 */

import { OpenAiInferenceProvider } from '../providers/openai.js';
import type { ChatImage, ChatMessage, CompletionDelta, ToolCall } from '../providers/provider.js';
import type { StorageSetup } from '../plugins.js';
import type { McpEndpoint, McpEndpoints } from '../shared/mcp-endpoints.js';
import { sanitizeEndpointLabel } from '../shared/mcp-endpoints.js';
import { closeWindow, minimizeWindow } from '../shared/nw.js';
import type {
  ModelEntry,
  ProviderAccount,
  ProviderRegistry,
  WorkspaceSettings,
} from '../shared/workspace.js';
import { emptyProviderRegistry } from '../shared/workspace.js';
import { agentToolDefinition, buildAgentTools, CHAT_AGENT_SOURCE, type AgentTool, type AgentToolOutput } from './agent-tools.js';
import { JsonViewerElement } from './json-viewer-element.js';
import type { McpClientManager } from './mcp-client/manager.js';
import type { McpConnectionInfo, McpHostHandle, McpSessionSink } from './mcp-host.js';
import type { NotificationHub } from './notification-hub.js';
import type { PermissionGate } from './permission-gate.js';
import { PermissionRequestElement, type PermissionResolveDetail } from './permission-request-element.js';
import { PluginFieldGroup } from './plugin-fields.js';
import { requireElement } from './dom.js';
import type { WorkspaceSettingsStore } from './settings-store.js';
import {
  EMPTY_SHARED_STORAGES,
  StorageShareRegistry,
  type SharedStoragesRecord,
  type StorageAccess,
  type SharedStorageEntry,
} from './storage-shares.js';
import { applyTheme, resolveThemeId, THEMES } from './theme.js';
import { FRAME_MODES, resolveFrameMode } from './frame-mode.js';
import type { ChildWindowManager } from './window-manager.js';

/** How many provider turns one chat message may spend on tool calls. */
const MAX_AGENT_TURNS = 12;

/** The longest edge of a pasted or dropped image, in pixels. Bigger pictures scale down. */
const MAX_IMAGE_EDGE = 1280;

/** How many images one chat message may carry. */
const MAX_ATTACHMENTS = 4;

/** Reads the image files out of one clipboard or drag file list. */
function imageFilesOf(files: FileList | null): readonly File[] {
  if (files === null) {
    return [];
  }
  return Array.from(files).filter((file) => file.type.startsWith('image/'));
}

/** Splits one command line into the executable and its arguments, honoring double-quoted pieces. */
function splitCommandLine(line: string): { readonly command: string; readonly args: readonly string[] } {
  const parts = line.trim().match(/"([^"]*)"|(\S+)/g) ?? [];
  const pieces = parts.map((part) =>
    part.length >= 2 && part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
  return { command: pieces[0] ?? '', args: pieces.slice(1) };
}

/** Formats one token count for the status bar: plain below 1000, one decimal in k above. */
function formatTokenCount(count: number | undefined): string {
  if (count === undefined) {
    return '–';
  }
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** One rendered chat entry. */
interface ChatEntry {
  readonly role: 'user' | 'assistant' | 'notice' | 'error' | 'tool';
  readonly content: string;
  /** The structured payload that a tool entry renders with the JSON viewer, when present. */
  readonly json?: unknown;
  /** The reasoning of an assistant reply, when the model reports one. It replays on the next request. */
  readonly reasoning?: string;
  /** The tool calls of an assistant reply, when the model requests tools instead of text. */
  readonly toolCalls?: readonly ToolCall[];
  /** The tool call this entry answers, on role tool. */
  readonly toolCallId?: string;
  /** The display name of the tool that produced this entry, on tool replies. */
  readonly toolName?: string;
  /** The images of the entry: attachments on user entries, image results on tool entries. */
  readonly images?: readonly ChatImage[];
  /** The short MCP session id that produced this entry, on entries of the host tab. */
  readonly mcpSession?: string;
}

/** One chat tab with its conversation. */
interface Chat {
  readonly id: number;
  readonly title: string;
  readonly entries: ChatEntry[];
  /** True when this tab is the one MCP host tab that logs every session. */
  readonly isMcpHostLog?: boolean;
  /** True while the tab sits in the background and took traffic the user has not seen. */
  unread?: boolean;
  /** The provider selection the status bar holds while the chat has sent no message. */
  pendingProviderId?: string;
  pendingModel?: string;
  /** The provider and model the chat bound on its first send. They stay for the life of the chat. */
  boundProviderId?: string;
  boundModel?: string;
  /** The context tokens of the last request, when the provider reported usage. */
  contextTokens?: number;
  /** The output tokens of the whole chat, summed over the requests the provider reported. */
  outputTokens?: number;
}

/** One render slot: an entry with its list index, the key of the reasoning open-state. */
interface EntrySlot {
  readonly index: number;
  readonly entry: ChatEntry;
}

/** One render group of the message list: one entry, an MCP request with its reply, or one agent
 * turn: the tool calls of an assistant reply with the tool results that answer them. */
type MessageGroup =
  | { readonly kind: 'single'; readonly slot: EntrySlot }
  | { readonly kind: 'pair'; readonly request: EntrySlot; readonly reply: EntrySlot | null }
  | { readonly kind: 'agent'; readonly request: EntrySlot; readonly replies: readonly EntrySlot[] };

/** Drives the main app screen. */
export class MainApp implements McpSessionSink {
  private readonly settings: WorkspaceSettings;
  private readonly store: WorkspaceSettingsStore;
  private readonly storageLabel: string;
  private readonly permissionGate: PermissionGate | null;
  private readonly windowManager: ChildWindowManager;
  private readonly mcpClients: McpClientManager;
  private readonly notificationHub: NotificationHub;
  private readonly workspacePath: string;
  private readonly storageShares: StorageShareRegistry;
  private readonly storageSetups: readonly StorageSetup[];
  private mcpHost: McpHostHandle | null = null;
  private registry: ProviderRegistry = emptyProviderRegistry();
  private mcpEndpoints: McpEndpoints = { endpoints: [] };
  private sharedStorages: SharedStoragesRecord = EMPTY_SHARED_STORAGES;
  private readonly chats: Chat[] = [];
  private activeChatId: number | null = null;
  private nextChatId = 1;
  /** The images that ride along with the next message, from paste or drop. */
  private pendingImages: ChatImage[] = [];

  private readonly tabSettings = requireElement<HTMLButtonElement>('#tab-settings');
  private readonly chatTabs = requireElement<HTMLElement>('#chat-tab-list');
  private readonly newChatButton = requireElement<HTMLButtonElement>('#new-chat');
  private readonly paneSettings = requireElement<HTMLElement>('#pane-settings');
  private readonly paneChat = requireElement<HTMLElement>('#pane-chat');
  private readonly chatMessages = requireElement<HTMLOListElement>('#chat-messages');
  private readonly chatForm = requireElement<HTMLFormElement>('#chat-form');
  private readonly chatInput = requireElement<HTMLInputElement>('#chat-input');
  private readonly chatAttachments = requireElement<HTMLElement>('#chat-attachments');
  private readonly chatSend = requireElement<HTMLButtonElement>('#chat-send');
  private readonly chatStatus = requireElement<HTMLElement>('#chat-status');
  private readonly providerList = requireElement<HTMLElement>('#provider-list');
  private readonly providerAdd = requireElement<HTMLDetailsElement>('#provider-add');
  private readonly providerAddForm = requireElement<HTMLFormElement>('#provider-add-form');
  private readonly providerAddLabel = requireElement<HTMLInputElement>('#provider-add-label');
  private readonly providerAddUrl = requireElement<HTMLInputElement>('#provider-add-url');
  private readonly providerAddKey = requireElement<HTMLInputElement>('#provider-add-key');
  private readonly providerAddSubmit = requireElement<HTMLButtonElement>('#provider-add-submit');
  private readonly providerStatus = requireElement<HTMLElement>('#provider-status');
  private readonly permissionRequests = requireElement<HTMLElement>('#permission-requests');
  private readonly mcpEndpointList = requireElement<HTMLElement>('#mcp-endpoint-list');
  private readonly mcpEndpointAdd = requireElement<HTMLDetailsElement>('#mcp-endpoint-add');
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

  /**
   * @param settings The workspace settings.
   * @param store The settings store of the workspace.
   * @param storageLabel The display label of the storage the workspace uses.
   * @param permissionGate The permission gate of the workspace, or null before one exists.
   * @param windowManager The child window manager the agent tools drive.
   * @param mcpClients The MCP client manager of the workspace.
   * @param notificationHub The notification hub of the workspace.
   * @param workspacePath The absolute path of the workspace directory.
   * @param storageShares The storage sharing registry of the workspace.
   * @param storageSetups The registered storage setups, for the add form.
   */
  constructor(
    settings: WorkspaceSettings,
    store: WorkspaceSettingsStore,
    storageLabel: string,
    permissionGate: PermissionGate | null,
    windowManager: ChildWindowManager,
    mcpClients: McpClientManager,
    notificationHub: NotificationHub,
    workspacePath: string,
    storageShares: StorageShareRegistry,
    storageSetups: readonly StorageSetup[],
  ) {
    this.settings = settings;
    this.store = store;
    this.storageLabel = storageLabel;
    this.permissionGate = permissionGate;
    this.windowManager = windowManager;
    this.mcpClients = mcpClients;
    this.notificationHub = notificationHub;
    this.workspacePath = workspacePath;
    this.storageShares = storageShares;
    this.storageSetups = storageSetups;
    this.notificationHub.setChatNotifier((text) => {
      this.pushChatNotification(text);
    });
  }

  /**
   * Loads the provider settings, opens the first chat, and wires the events.
   *
   * @param mcpHost The running MCP host handle, or null when the host stays off.
   * @throws Error when the document misses a required element.
   */
  async start(mcpHost: McpHostHandle | null): Promise<void> {
    this.mcpHost = mcpHost;
    PermissionRequestElement.define();
    JsonViewerElement.define();
    this.permissionGate?.subscribe(() => {
      this.renderPermissionRequests();
      this.renderTabs();
    });
    requireElement<HTMLElement>('#workspace-name').textContent = this.settings.name;
    requireElement<HTMLElement>('#workspace-storage-mode').textContent = this.storageLabel;
    try {
      this.registry = await this.store.loadProviderRegistry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] could not read the provider registry: ${message}`);
    }
    try {
      this.mcpEndpoints = await this.store.loadMcpEndpoints();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] could not read the MCP endpoints: ${message}`);
    }
    try {
      this.sharedStorages = await this.store.loadSharedStorages();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] could not read the storage sharing: ${message}`);
    }
    void this.mcpClients.applyEndpoints(this.mcpEndpoints);
    this.mcpClients.subscribe(() => {
      this.renderMcpEndpoints();
    });
    this.storageShares.applyRecord(this.sharedStorages);
    await this.initializeThemeControls();
    await this.initializeFrameControls();
    this.initializeMcpHostSection();
    this.initializeMcpEndpointsSection();
    this.initializeStorageShareSection();
    this.initializeProviderSection();
    requireElement<HTMLButtonElement>('#app-close').addEventListener('click', () => {
      closeWindow();
    });
    requireElement<HTMLButtonElement>('#app-minimize').addEventListener('click', () => {
      minimizeWindow();
    });
    this.tabSettings.addEventListener('click', () => {
      this.activateSettings();
    });
    this.newChatButton.addEventListener('click', () => {
      this.newChat();
    });
    // A vertical wheel over the strip scrolls it, so a full strip stays reachable with no visible scrollbar.
    // A horizontal wheel keeps its default, so the trackpad swipe does not scroll twice.
    this.chatTabs.addEventListener(
      'wheel',
      (event) => {
        const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        if (this.chatTabs.scrollWidth <= this.chatTabs.clientWidth || Math.abs(event.deltaX) >= Math.abs(delta)) {
          return;
        }
        event.preventDefault();
        this.chatTabs.scrollLeft += delta;
      },
      { passive: false },
    );
    this.providerAddForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.addProviderFromForm();
    });
    this.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    this.chatInput.addEventListener('paste', (event) => {
      const files = imageFilesOf(event.clipboardData?.files ?? null);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      void this.addImageFiles(files);
    });
    this.paneChat.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    this.paneChat.addEventListener('drop', (event) => {
      event.preventDefault();
      void this.addImageFiles(imageFilesOf(event.dataTransfer?.files ?? null));
    });
    this.newChat();
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
          console.warn(`[NodeWavenUI] the MCP host token could not be copied: ${message}`);
        });
    });
  }

  /** Wires the MCP endpoints section: the endpoint cards, the add form, and the live connection states. */
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
    const transport: McpEndpoint['transport'] = isHttp
      ? { kind: 'http', url: this.mcpAddUrl.value.trim(), ...(token.length > 0 ? { token } : {}) }
      : {
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
    this.mcpAddLabel.value = '';
    this.mcpAddUrl.value = '';
    this.mcpAddToken.value = '';
    this.mcpAddCommand.value = '';
    this.persistMcpEndpoints({ endpoints: [...this.mcpEndpoints.endpoints, endpoint] }, 'Endpoint added.');
  }

  /** Stores the next endpoint list, applies it to the connections, and re-renders the cards. */
  private persistMcpEndpoints(next: McpEndpoints, successText: string): void {
    this.mcpEndpoints = next;
    void this.mcpClients.applyEndpoints(next);
    this.renderMcpEndpoints();
    void this.store
      .saveMcpEndpoints(next)
      .then(() => {
        this.showMcpEndpointStatus(successText, false);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.showMcpEndpointStatus(message, true);
      });
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
  private buildMcpEndpointCard(endpoint: McpEndpoint, state: { state: string; error: string | null } | null): HTMLElement {
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
      !state
        ? 'disabled'
        : state.state === 'error' && state.error
          ? `error: ${state.error}`
          : state.state;
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

  /** McpSessionSink: every MCP session logs into one shared host tab, and each new connection posts its facts. */
  sessionOpened(sessionId: string, info: McpConnectionInfo): void {
    const chat = this.mcpHostTab() ?? this.createMcpHostTab();
    const facts: string[] = [];
    if (info.clientName) {
      facts.push(`client "${info.clientVersion ? `${info.clientName} ${info.clientVersion}` : info.clientName}"`);
    }
    if (info.protocolVersion) {
      facts.push(`protocol ${info.protocolVersion}`);
    }
    if (info.userAgent) {
      facts.push(`user agent "${info.userAgent}"`);
    }
    const detail = facts.length > 0 ? facts.join(', ') : 'no client facts';
    chat.entries.push({
      role: 'notice',
      content: `Connection ${sessionId.slice(0, 8)} at ${new Date().toLocaleTimeString()} — ${detail}.`,
    });
    if (chat.id === this.activeChatId) {
      this.renderMessages();
      return;
    }
    chat.unread = true;
    this.renderTabs();
  }

  /** Reads the one host tab, or null before the first connection. */
  private mcpHostTab(): Chat | null {
    return this.chats.find((candidate) => candidate.isMcpHostLog) ?? null;
  }

  /** Creates the host tab and activates it, the first time a client connects. It sits before every chat tab. */
  private createMcpHostTab(): Chat {
    const chat: Chat = {
      id: this.nextChatId,
      title: 'MCP Host',
      entries: [],
      isMcpHostLog: true,
    };
    this.nextChatId += 1;
    this.chats.unshift(chat);
    this.activateChat(chat.id);
    return chat;
  }

  /** McpSessionSink: one tool call of a session lands in the host tab, its arguments in the JSON viewer. */
  toolCall(sessionId: string, toolName: string, args: Record<string, unknown>): void {
    this.appendMcpEntry(sessionId, 'user', toolName, args, toolName);
  }

  /** McpSessionSink: one tool result of a session lands in the host tab, a JSON reply in the viewer. */
  toolResult(sessionId: string, toolName: string, summary: string, isError: boolean, json?: unknown): void {
    this.appendMcpEntry(sessionId, isError ? 'error' : 'assistant', summary, json, toolName);
  }

  /** McpSessionSink: one notification a client sent the host reaches the hub. */
  clientNotification(sessionId: string, method: string, params: unknown): void {
    this.notificationHub.dispatch(method, params, `host-session ${sessionId.slice(0, 8)}`);
  }

  private appendMcpEntry(sessionId: string, role: ChatEntry['role'], content: string, json?: unknown, toolName?: string): void {
    const chat = this.mcpHostTab() ?? this.createMcpHostTab();
    chat.entries.push({
      role,
      content,
      ...(json ? { json } : {}),
      ...(toolName ? { toolName } : {}),
      mcpSession: sessionId.slice(0, 8),
    });
    if (chat.id === this.activeChatId) {
      this.renderMessages();
      return;
    }
    // The tab sits in the background, so the entry marks it unread.
    chat.unread = true;
    this.renderTabs();
  }

  /** Lands one notification as a user message in the active chat, so the chat agent sees it on its next turn. */
  private pushChatNotification(text: string): void {
    const chat = this.activeChat() ?? this.chats.at(-1) ?? null;
    if (!chat) {
      return;
    }
    chat.entries.push({ role: 'user', content: text });
    if (chat.id === this.activeChatId) {
      this.renderMessages();
      return;
    }
    chat.unread = true;
    this.renderTabs();
  }

  /** Renders the pending permission requests of the active chat tab above the chat input.
   * The host tab shows every host session's requests, a plain chat tab shows the chat agent's requests.
   * Requests of the other side stay behind their tabs; the bar names them, so a waiting request is never invisible. */
  private renderPermissionRequests(): void {
    this.permissionRequests.replaceChildren();
    const gate = this.permissionGate;
    if (!gate) {
      this.permissionRequests.hidden = true;
      return;
    }
    const chat = this.activeChat();
    const hostTabActive = Boolean(chat?.isMcpHostLog);
    const all = gate.pendingRequests();
    const requests = all.filter((request) => (request.source === CHAT_AGENT_SOURCE) !== hostTabActive);
    for (const request of requests) {
      const card = document.createElement('permission-request') as PermissionRequestElement;
      card.request = request;
      card.addEventListener('permission-resolve', (event: Event) => {
        const detail = (event as CustomEvent<PermissionResolveDetail>).detail;
        void gate.resolveRequest(detail.id, detail.approve, detail.remember);
      });
      this.permissionRequests.append(card);
    }
    if (requests.length === 0 && all.length > 0) {
      const notice = document.createElement('p');
      notice.className = 'permission-request-waiting';
      notice.textContent = hostTabActive
        ? 'A permission request waits in a chat tab. Open the tab to answer it.'
        : 'A permission request waits in the MCP Host tab. Open the tab to answer it.';
      this.permissionRequests.append(notice);
    }
    this.permissionRequests.hidden = this.permissionRequests.childElementCount === 0;
  }

  /** Loads the theme of the workspace and wires the theme dropdown of the settings pane. */
  private async initializeThemeControls(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = await this.store.loadThemePreference();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored theme could not be read, the default applies: ${message}`);
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
        console.warn(`[NodeWavenUI] the theme choice could not be saved: ${message}`);
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
      console.warn(`[NodeWavenUI] the stored window frame could not be read, the default applies: ${message}`);
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
        console.warn(`[NodeWavenUI] the window frame choice could not be saved: ${message}`);
      });
    });
  }

  /** Renders the provider cards. The add form is a collapsed disclosure below the list. */
  private initializeProviderSection(): void {
    this.renderProviders();
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
    if (this.registry.accounts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No provider is configured. Add one below.';
      this.providerList.append(empty);
      return;
    }
    for (const account of this.registry.accounts) {
      const card = this.buildProviderCard(account);
      if (openIds.has(account.id)) {
        card.open = true;
      }
      this.providerList.append(card);
    }
  }

  /** The account the chats use: the chosen default, or the first one. */
  private effectiveDefaultAccount(): ProviderAccount | null {
    return (
      this.registry.accounts.find((account) => account.id === this.registry.defaultProviderId) ??
      this.registry.accounts[0] ??
      null
    );
  }

  /** The model the chats use: the chosen default when it belongs to the account, or the account's first. */
  private effectiveDefaultModel(account: ProviderAccount): string | null {
    const wanted = this.registry.defaultModel;
    if (wanted && account.models.some((model) => model.id === wanted)) {
      return wanted;
    }
    return account.models[0]?.id ?? null;
  }

  /** Reads the vision flag of one model of an account. An unknown model reads text only. */
  private modelVision(account: ProviderAccount, modelId: string | null): boolean {
    if (modelId === null) {
      return false;
    }
    return account.models.find((model) => model.id === modelId)?.vision ?? false;
  }

  /** The status-bar display name of one model: the id, plus the vision marker when the model sees images. */
  private modelDisplayName(account: ProviderAccount, modelId: string): string {
    return this.modelVision(account, modelId) ? `${modelId} · vision` : modelId;
  }

  /** Stores the next registry, re-renders the cards, and reports the outcome. */
  private persistRegistry(next: ProviderRegistry, successText: string): void {
    this.registry = next;
    this.renderProviders();
    this.renderChatStatus();
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
      models: [],
    };
    this.providerAddLabel.value = '';
    this.providerAddUrl.value = '';
    this.providerAddKey.value = '';
    this.updateAddFormState();
    const isFirst = this.registry.accounts.length === 0;
    this.persistRegistry(
      {
        accounts: [...this.registry.accounts, account],
        defaultProviderId: isFirst ? account.id : this.registry.defaultProviderId,
        defaultModel: this.registry.defaultModel,
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
    if (this.effectiveDefaultAccount()?.id === account.id) {
      const badge = document.createElement('span');
      badge.className = 'provider-default';
      badge.textContent = 'Default';
      head.append(badge);
    }
    const title = document.createElement('span');
    title.className = 'provider-card-title';
    title.textContent = account.label;
    const modelCount = account.models.length;
    const meta = document.createElement('span');
    meta.className = 'provider-card-meta';
    meta.textContent = modelCount === 1 ? '1 model' : `${modelCount} models`;
    head.append(title, meta);

    const body = document.createElement('div');
    body.className = 'provider-card-body';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = account.label;
    labelInput.placeholder = 'Label';
    labelInput.className = 'provider-label';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = account.baseUrl;
    urlInput.placeholder = 'https://api.moonshot.ai/v1';
    urlInput.spellcheck = false;
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.value = account.apiKey;
    keyInput.placeholder = 'API key';

    const models = document.createElement('div');
    models.className = 'provider-models';
    // Only the default model of the default account reads "In use": every other model offers its Use button,
    // so the default pair can move anywhere, one-model accounts included.
    const defaultAccount = this.effectiveDefaultAccount();
    const defaultModel = defaultAccount ? this.effectiveDefaultModel(defaultAccount) : null;
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
    const visionLabel = document.createElement('label');
    visionLabel.className = 'model-vision';
    const visionInput = document.createElement('input');
    visionInput.type = 'checkbox';
    visionInput.title = 'The model reads image parts: pasted, dropped, and screenshotted pictures reach it.';
    visionLabel.append(visionInput, document.createTextNode('Vision'));
    const addModelButton = document.createElement('button');
    addModelButton.type = 'button';
    addModelButton.textContent = 'Add model';
    addModelButton.addEventListener('click', () => {
      this.addModel(account.id, modelInput.value, visionInput.checked);
      modelInput.value = '';
      visionInput.checked = false;
    });
    addModelRow.append(modelInput, visionLabel, addModelButton);

    const actions = document.createElement('div');
    actions.className = 'provider-card-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'primary provider-save';
    saveButton.textContent = 'Save';
    saveButton.disabled = true;
    saveButton.addEventListener('click', () => {
      this.saveAccount(account.id, labelInput.value.trim() || 'Provider', urlInput.value.trim(), keyInput.value);
    });
    const isDefaultAccount = this.effectiveDefaultAccount()?.id === account.id;
    const defaultButton = document.createElement('button');
    defaultButton.type = 'button';
    defaultButton.textContent = isDefaultAccount ? 'Default' : 'Set default';
    defaultButton.disabled = isDefaultAccount;
    defaultButton.title = 'New chats pick this provider and its current default model.';
    defaultButton.addEventListener('click', () => {
      this.makeDefaultProvider(account.id);
    });
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      this.removeProvider(account.id);
    });
    actions.append(saveButton, defaultButton, removeButton);

    /** The save action enables while an edited value differs from the stored account. */
    const updateSaveState = (): void => {
      const dirty =
        (labelInput.value.trim() || 'Provider') !== account.label ||
        urlInput.value.trim() !== account.baseUrl ||
        keyInput.value !== account.apiKey;
      saveButton.disabled = !dirty;
      card.classList.toggle('dirty', dirty);
    };
    for (const field of [labelInput, urlInput, keyInput]) {
      field.addEventListener('input', updateSaveState);
    }

    body.append(labelInput, urlInput, keyInput, models, addModelRow, actions);
    card.append(head, body);
    return card;
  }

  private buildModelRow(account: ProviderAccount, model: ModelEntry, isDefault: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'provider-model';
    const name = document.createElement('span');
    name.className = 'provider-model-name';
    name.textContent = model.id;
    const visionLabel = document.createElement('label');
    visionLabel.className = 'model-vision';
    const visionInput = document.createElement('input');
    visionInput.type = 'checkbox';
    visionInput.checked = model.vision;
    visionInput.title = 'The model reads image parts: pasted, dropped, and screenshotted pictures reach it.';
    visionInput.addEventListener('change', () => {
      this.setModelVision(account.id, model.id, visionInput.checked);
    });
    visionLabel.append(visionInput, document.createTextNode('Vision'));
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.textContent = isDefault ? 'In use' : 'Use';
    useButton.disabled = isDefault;
    useButton.addEventListener('click', () => {
      this.makeDefault(account.id, model.id);
    });
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = `Remove ${model.id}`;
    removeButton.addEventListener('click', () => {
      this.removeModel(account.id, model.id);
    });
    row.append(name, visionLabel, useButton, removeButton);
    return row;
  }

  private accountById(id: string): ProviderAccount | null {
    return this.registry.accounts.find((account) => account.id === id) ?? null;
  }

  /** Rewrites one account in the registry. */
  private withAccount(id: string, rewrite: (account: ProviderAccount) => ProviderAccount, successText: string): void {
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    this.persistRegistry(
      { ...this.registry, accounts: this.registry.accounts.map((candidate) => (candidate.id === id ? rewrite(candidate) : candidate)) },
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
        accounts: this.registry.accounts.map((candidate) =>
          candidate.id === id ? { ...candidate, models: [...candidate.models, { id: trimmed, vision }] } : candidate,
        ),
        defaultProviderId: this.registry.defaultProviderId ?? id,
        defaultModel: this.registry.defaultModel ?? trimmed,
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
    const wasDefault = this.registry.defaultModel === model;
    const nextDefault = wasDefault ? (models[0]?.id ?? null) : this.registry.defaultModel;
    this.persistRegistry(
      {
        ...this.registry,
        accounts: this.registry.accounts.map((candidate) => (candidate.id === id ? { ...candidate, models } : candidate)),
        defaultModel: nextDefault,
      },
      'Model removed.',
    );
  }

  private makeDefault(id: string, model: string): void {
    this.persistRegistry({ ...this.registry, defaultProviderId: id, defaultModel: model }, 'Default set.');
  }

  /** Makes one account the default provider, with its effective model as the default model. */
  private makeDefaultProvider(id: string): void {
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    this.persistRegistry(
      { ...this.registry, defaultProviderId: id, defaultModel: this.effectiveDefaultModel(account) },
      'Default set.',
    );
  }

  private removeProvider(id: string): void {
    const accounts = this.registry.accounts.filter((account) => account.id !== id);
    const wasDefault = this.registry.defaultProviderId === id;
    const nextDefaultAccount = wasDefault ? (accounts[0] ?? null) : this.effectiveDefaultAccount();
    const nextDefaultModel = nextDefaultAccount ? this.effectiveDefaultModel(nextDefaultAccount) : null;
    this.persistRegistry(
      {
        accounts,
        defaultProviderId: nextDefaultAccount?.id ?? null,
        defaultModel: nextDefaultModel,
      },
      'Provider removed.',
    );
  }

  /** The connection one chat runs on: its bound provider and model, or the status bar selection.
   * Null when the chat has no usable provider, or when its bound provider no longer exists. */
  private resolveChatConnection(chat: Chat): { account: ProviderAccount; model: string; vision: boolean } | null {
    if (chat.boundProviderId) {
      const account = this.registry.accounts.find((candidate) => candidate.id === chat.boundProviderId);
      if (!account || !chat.boundModel) {
        return null;
      }
      return { account, model: chat.boundModel, vision: this.modelVision(account, chat.boundModel) };
    }
    const account =
      this.registry.accounts.find((candidate) => candidate.id === chat.pendingProviderId) ??
      this.effectiveDefaultAccount();
    if (!account) {
      return null;
    }
    const model =
      chat.pendingModel && account.models.some((candidate) => candidate.id === chat.pendingModel)
        ? chat.pendingModel
        : this.effectiveDefaultModel(account);
    if (!model) {
      return null;
    }
    return { account, model, vision: this.modelVision(account, model) };
  }

  private showProviderStatus(message: string, isError: boolean): void {
    this.providerStatus.textContent = message;
    this.providerStatus.className = isError ? 'status error' : 'status';
    this.providerStatus.hidden = false;
  }

  private async send(): Promise<void> {
    const chat = this.activeChat();
    const text = this.chatInput.value.trim();
    const images = this.pendingImages;
    if (!chat || (text.length === 0 && images.length === 0) || this.chatSend.disabled) {
      return;
    }
    const connection = this.resolveChatConnection(chat);
    if (connection && images.length > 0 && !connection.vision) {
      // Nothing is consumed: the text stays typed and the chips stay pending, so the user can switch model or remove the images.
      chat.entries.push({
        role: 'notice',
        content: `The model "${connection.model}" reads text only. Turn on its Vision flag in the settings, or remove the images.`,
      });
      this.renderMessages();
      return;
    }
    chat.entries.push({ role: 'user', content: text, ...(images.length > 0 ? { images: [...images] } : {}) });
    this.chatInput.value = '';
    this.pendingImages = [];
    this.renderAttachments();
    if (!connection) {
      chat.entries.push({
        role: chat.boundProviderId ? 'error' : 'notice',
        content: chat.boundProviderId
          ? 'The provider of this chat no longer exists. Open a new chat tab for a different model.'
          : 'No provider is configured. Open the Settings tab, add a provider, and give it a model.',
      });
      this.renderMessages();
      return;
    }
    const provider = new OpenAiInferenceProvider({
      baseUrl: connection.account.baseUrl,
      apiKey: connection.account.apiKey,
    });
    if (!chat.boundProviderId) {
      // The first send binds the chat to this provider and model, and locks the status bar.
      chat.boundProviderId = connection.account.id;
      chat.boundModel = connection.model;
      this.renderChatStatus();
    }
    this.renderMessages();
    this.setChatBusy(true);
    try {
      await this.runAgentTurn(chat, provider, connection.model, connection.vision);
    } catch (error) {
      chat.entries.push({
        role: 'error',
        content: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.setChatBusy(false);
      this.renderMessages();
    }
  }

  /** Adds image files from paste or drop to the pending attachments, downscaled and capped. */
  private async addImageFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const room = MAX_ATTACHMENTS - this.pendingImages.length;
    if (room <= 0) {
      this.activeChat()?.entries.push({
        role: 'notice',
        content: `One message carries at most ${MAX_ATTACHMENTS} images.`,
      });
      this.renderMessages();
      return;
    }
    if (files.length > room) {
      this.activeChat()?.entries.push({
        role: 'notice',
        content: `One message carries at most ${MAX_ATTACHMENTS} images. The first ${room} ${room === 1 ? 'stays' : 'stay'}, the rest drop.`,
      });
      this.renderMessages();
    }
    for (const file of files.slice(0, room)) {
      try {
        this.pendingImages.push(await this.readImageFile(file));
      } catch (error) {
        console.warn(`[NodeWavenUI] the image "${file.name}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.renderAttachments();
  }

  /** Reads one image file as chat image data, scaled down to the attachment size box. */
  private async readImageFile(file: File): Promise<ChatImage> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('The page could not create a drawing context.');
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const prefix = 'data:image/png;base64,';
    const dataUrl = canvas.toDataURL('image/png');
    return { data: dataUrl.slice(prefix.length), mimeType: 'image/png' };
  }

  /** Renders the pending attachments as thumbnails with a remove button each. */
  private renderAttachments(): void {
    this.chatAttachments.hidden = this.pendingImages.length === 0;
    this.chatAttachments.replaceChildren();
    this.pendingImages.forEach((image, index) => {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      const thumbnail = document.createElement('img');
      thumbnail.src = `data:${image.mimeType};base64,${image.data}`;
      thumbnail.alt = 'attachment';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Remove';
      remove.addEventListener('click', () => {
        this.pendingImages.splice(index, 1);
        this.renderAttachments();
      });
      chip.append(thumbnail, remove);
      this.chatAttachments.append(chip);
    });
  }

  /** The tools the agent may call this turn, the built-ins plus the native MCP tools. */
  private agentTools(): readonly AgentTool[] {
    return buildAgentTools({
      windowManager: this.windowManager,
      gate:
        this.permissionGate ?? {
          check: async () => {
            throw new Error('No permission gate is wired.');
          },
        },
      mcpClients: this.mcpClients,
      workspacePath: this.workspacePath,
      storageShares: this.storageShares,
    });
  }

  /** Runs the tool-calling loop of one user message, until the model answers in text or hits the turn cap. */
  private async runAgentTurn(chat: Chat, provider: OpenAiInferenceProvider, model: string, vision: boolean): Promise<void> {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
      const tools = this.agentTools();
      const messages = this.agentMessages(chat, vision);
      const streaming = this.beginStreamingEntry(chat);
      const result = await provider.complete({
        model,
        messages,
        tools: tools.map(agentToolDefinition),
        onDelta: streaming.onDelta,
      });
      if (result.usage) {
        chat.contextTokens = result.usage.promptTokens;
        chat.outputTokens = (chat.outputTokens ?? 0) + result.usage.completionTokens;
        this.renderChatStatus();
      }
      if (result.toolCalls && result.toolCalls.length > 0) {
        streaming.settle({
          role: 'assistant',
          content: result.content,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          toolCalls: result.toolCalls,
        });
        for (const call of result.toolCalls) {
          await this.runAgentToolCall(chat, tools, call);
        }
        continue;
      }
      streaming.settle({
        role: 'assistant',
        content: result.content,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      });
      return;
    }
    chat.entries.push({
      role: 'error',
      content: `The agent exceeded ${MAX_AGENT_TURNS} tool turns in one message.`,
    });
  }

  /** Runs one tool call of the agent and appends the result entry the next request retransmits. */
  private async runAgentToolCall(chat: Chat, tools: readonly AgentTool[], call: ToolCall): Promise<void> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      args = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = { _raw: call.arguments };
    }
    let output: AgentToolOutput;
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) {
      output = { text: `Error: no tool named "${call.name}" exists.` };
    } else {
      try {
        output = await tool.run(args);
      } catch (error) {
        output = { text: `Error: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    // A JSON object or array reply rides along as a payload, so the tab shows it in the viewer.
    let json: unknown;
    try {
      const parsed: unknown = JSON.parse(output.text);
      json = typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
      json = undefined;
    }
    chat.entries.push({
      role: 'tool',
      content: output.text,
      ...(json ? { json } : {}),
      ...(output.images && output.images.length > 0 ? { images: output.images } : {}),
      toolCallId: call.id,
      toolName: call.name,
    });
    this.renderMessages();
  }

  /** Reads the entries of one chat as the message list of the next provider request. */
  private agentMessages(chat: Chat, vision: boolean): ChatMessage[] {
    const messages: ChatMessage[] = [];
    // Tool images travel as one user message after the tool batch, because tool messages carry text only.
    // A model without vision reads an omission note instead.
    const toolImages: ChatImage[] = [];
    const flushToolImages = (): void => {
      if (toolImages.length === 0) {
        return;
      }
      if (vision) {
        messages.push({ role: 'user', content: 'The images of the tool results above, in order.', images: [...toolImages] });
      }
      toolImages.length = 0;
    };
    for (const entry of chat.entries) {
      if (entry.role === 'user') {
        flushToolImages();
        messages.push({
          role: 'user',
          content: entry.content,
          ...(vision && entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
        });
      } else if (entry.role === 'assistant') {
        flushToolImages();
        messages.push({
          role: 'assistant',
          content: entry.content,
          ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
          ...(entry.toolCalls && entry.toolCalls.length > 0 ? { toolCalls: entry.toolCalls } : {}),
        });
      } else if (entry.role === 'tool') {
        let content = entry.content;
        if (!vision && entry.images && entry.images.length > 0) {
          content += `\n[${entry.images.length} ${entry.images.length === 1 ? 'image' : 'images'} omitted: the model reads text only]`;
        }
        messages.push({
          role: 'tool',
          content,
          ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        });
        if (entry.images) {
          toolImages.push(...entry.images);
        }
      }
    }
    flushToolImages();
    return messages;
  }

  /**
   * Opens one in-flight assistant entry that streams the reply, and settles it with the final entry.
   * The renders stay throttled, so a long stream does not thrash the message list.
   */
  private beginStreamingEntry(chat: Chat): { onDelta: (delta: CompletionDelta) => void; settle: (entry: ChatEntry) => void } {
    let liveContent = '';
    let liveReasoning = '';
    chat.entries.push({ role: 'assistant', content: '' });
    let lastStreamRender = 0;
    const renderStreamed = (force: boolean): void => {
      const now = Date.now();
      if (force || now - lastStreamRender >= 80) {
        lastStreamRender = now;
        this.patchStreamingEntry(chat);
      }
    };
    renderStreamed(true);
    return {
      onDelta: (delta: CompletionDelta): void => {
        if (delta.content) {
          liveContent += delta.content;
        }
        if (delta.reasoning) {
          liveReasoning += delta.reasoning;
        }
        chat.entries[chat.entries.length - 1] = {
          role: 'assistant',
          content: liveContent,
          ...(liveReasoning.length > 0 ? { reasoning: liveReasoning } : {}),
        };
        renderStreamed(false);
      },
      settle: (entry: ChatEntry): void => {
        chat.entries[chat.entries.length - 1] = entry;
        this.renderMessages();
      },
    };
  }

  /**
   * Patches the streaming entry into the live list item instead of rebuilding the whole list,
   * so a click or an open disclosure never fights the stream renders.
   * A missing or replaced list item falls back to one full render.
   */
  private patchStreamingEntry(chat: Chat): void {
    const index = chat.entries.length - 1;
    const entry = chat.entries[index];
    const item = this.chatMessages.lastElementChild;
    if (!entry || entry.role !== 'assistant' || !(item instanceof HTMLElement) || item.dataset.entryIndex !== String(index)) {
      this.renderMessages();
      return;
    }
    const text = item.querySelector(':scope > .message-text');
    const body = item.querySelector(':scope > details.reasoning > .reasoning-body');
    if (!(text instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      this.renderMessages();
      return;
    }
    text.textContent = entry.content;
    body.textContent = entry.reasoning ?? '';
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  private setChatBusy(busy: boolean): void {
    this.chatSend.disabled = busy;
    this.chatInput.disabled = busy;
    if (!busy) {
      this.chatInput.focus();
    }
  }

  private newChat(): void {
    const chat: Chat = { id: this.nextChatId, title: `Chat ${this.nextChatId}`, entries: [] };
    this.nextChatId += 1;
    this.chats.push(chat);
    this.activateChat(chat.id);
  }

  private closeChat(id: number): void {
    const index = this.chats.findIndex((chat) => chat.id === id);
    if (index < 0) {
      return;
    }
    this.chats.splice(index, 1);
    if (this.activeChatId === id) {
      this.activateSettings();
      return;
    }
    this.renderTabs();
  }

  private activateChat(id: number): void {
    this.activeChatId = id;
    const chat = this.chats.find((candidate) => candidate.id === id);
    if (chat) {
      chat.unread = false;
    }
    this.paneSettings.hidden = true;
    this.paneChat.hidden = false;
    // The MCP host tab logs traffic. The host cannot push a message to the connected clients,
    // so the tab carries no message input and no status bar of a chat that cannot send.
    const sessionLog = Boolean(chat?.isMcpHostLog);
    this.chatForm.hidden = sessionLog;
    this.chatStatus.hidden = sessionLog;
    this.renderTabs();
    this.renderMessages();
    this.renderPermissionRequests();
    this.renderChatStatus();
    if (!sessionLog) {
      this.chatInput.focus();
    }
  }

  private activateSettings(): void {
    this.activeChatId = null;
    this.paneSettings.hidden = false;
    this.paneChat.hidden = true;
    this.renderTabs();
    this.renderChatStatus();
  }

  private activeChat(): Chat | null {
    const id = this.activeChatId;
    if (!id) {
      return null;
    }
    return this.chats.find((chat) => chat.id === id) ?? null;
  }

  private renderTabs(): void {
    // The sources of the queued permission requests, so the tabs that hold one stand out.
    const pendingSources = new Set(this.permissionGate?.pendingRequests().map((request) => request.source) ?? []);
    // The host tab badges when any host session waits; a plain chat badges when the chat agent waits.
    const hostWaits = [...pendingSources].some((source) => source !== CHAT_AGENT_SOURCE);
    const chatWaits = pendingSources.has(CHAT_AGENT_SOURCE);
    this.chatTabs.replaceChildren();
    for (const chat of this.chats) {
      const group = document.createElement('span');
      const classes = ['tab-group'];
      if (chat.id === this.activeChatId) {
        classes.push('active');
      }
      if (chat.unread) {
        classes.push('unread');
      }
      if (chat.isMcpHostLog ? hostWaits : chatWaits) {
        classes.push('permissions');
      }
      group.className = classes.join(' ');
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.textContent = chat.title;
      tab.addEventListener('click', () => {
        this.activateChat(chat.id);
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.title = `Close ${chat.title}`;
      close.textContent = '×';
      close.addEventListener('click', () => {
        this.closeChat(chat.id);
      });
      group.append(tab, close);
      this.chatTabs.append(group);
    }
    this.tabSettings.classList.toggle('active', !this.activeChatId);
    this.tabSettings.classList.toggle('permissions', pendingSources.has(CHAT_AGENT_SOURCE));
    // The active tab scrolls into view, so a full strip keeps it reachable.
    this.chatTabs.querySelector<HTMLElement>('.tab-group.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Renders the status bar of the active chat: the provider and model of the tab, and the token usage.
   * The provider and model stand as selects until the first send binds the chat, then as locked labels. */
  private renderChatStatus(): void {
    this.chatStatus.replaceChildren();
    const chat = this.activeChat();
    if (!chat) {
      return;
    }
    const usage = document.createElement('span');
    usage.className = 'chat-status-usage';
    usage.title = 'Context tokens of the last request · output tokens of the whole chat';
    usage.textContent = `ctx ${formatTokenCount(chat.contextTokens)} · out ${formatTokenCount(chat.outputTokens)}`;
    if (chat.boundProviderId) {
      const account = this.registry.accounts.find((candidate) => candidate.id === chat.boundProviderId);
      const providerLabel = document.createElement('span');
      providerLabel.className = 'chat-status-label';
      providerLabel.textContent = account?.label ?? 'unknown provider';
      const modelLabel = document.createElement('span');
      modelLabel.className = 'chat-status-label';
      modelLabel.textContent =
        account && chat.boundModel ? this.modelDisplayName(account, chat.boundModel) : (chat.boundModel ?? '–');
      this.chatStatus.append(providerLabel, modelLabel, usage);
      return;
    }
    if (this.registry.accounts.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'chat-status-label';
      empty.textContent = 'No provider';
      this.chatStatus.append(empty, usage);
      return;
    }
    const selectedAccount =
      this.registry.accounts.find((candidate) => candidate.id === chat.pendingProviderId) ??
      this.effectiveDefaultAccount();
    if (!selectedAccount) {
      return;
    }
    const providerSelect = document.createElement('select');
    providerSelect.title = 'The provider of the first message. The chat stays on it after the send.';
    for (const account of this.registry.accounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.label;
      providerSelect.append(option);
    }
    providerSelect.value = selectedAccount.id;
    const modelSelect = document.createElement('select');
    modelSelect.title = 'The model of the first message. The chat stays on it after the send.';
    const renderModelOptions = (account: ProviderAccount): void => {
      modelSelect.replaceChildren();
      for (const model of account.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = this.modelDisplayName(account, model.id);
        modelSelect.append(option);
      }
      const pending =
        chat.pendingModel && account.models.some((candidate) => candidate.id === chat.pendingModel)
          ? chat.pendingModel
          : this.effectiveDefaultModel(account);
      if (pending) {
        modelSelect.value = pending;
      }
    };
    renderModelOptions(selectedAccount);
    providerSelect.addEventListener('change', () => {
      chat.pendingProviderId = providerSelect.value;
      delete chat.pendingModel;
      const next = this.registry.accounts.find((candidate) => candidate.id === providerSelect.value);
      if (next) {
        renderModelOptions(next);
      }
    });
    modelSelect.addEventListener('change', () => {
      chat.pendingModel = modelSelect.value;
    });
    this.chatStatus.append(providerSelect, modelSelect, usage);
  }

  /** Groups the entries of one chat for the message list: an MCP request pairs with the reply that
   * follows it, and the tool calls of one agent turn pair with the tool results that answer them.
   * A request still in flight, or brushed aside by an unrelated entry, renders with the wait hint. */
  private groupChatEntries(chat: Chat): readonly MessageGroup[] {
    const groups: MessageGroup[] = [];
    let open: EntrySlot | null = null;
    const flush = (): void => {
      if (open) {
        groups.push({ kind: 'pair', request: open, reply: null });
        open = null;
      }
    };
    for (let index = 0; index < chat.entries.length; index += 1) {
      const entry = chat.entries[index];
      if (!entry) {
        continue;
      }
      const slot: EntrySlot = { index, entry };
      if (entry.role === 'user' && entry.json && entry.toolName) {
        // A second request while one waits in flight closes the waiting one as unanswered.
        flush();
        open = slot;
      } else if (entry.role !== 'user' && entry.role !== 'tool' && entry.toolName) {
        if (open) {
          groups.push({ kind: 'pair', request: open, reply: slot });
          open = null;
        } else {
          groups.push({ kind: 'single', slot });
        }
      } else if (entry.role === 'assistant' && entry.toolCalls && entry.toolCalls.length > 0) {
        flush();
        // The tool results follow the assistant reply in call order, until a different role speaks.
        const replies: EntrySlot[] = [];
        let cursor = index + 1;
        while (cursor < chat.entries.length) {
          const candidate = chat.entries[cursor];
          if (!candidate || candidate.role !== 'tool') {
            break;
          }
          replies.push({ index: cursor, entry: candidate });
          cursor += 1;
        }
        groups.push({ kind: 'agent', request: slot, replies });
        index = cursor - 1;
      } else {
        flush();
        groups.push({ kind: 'single', slot });
      }
    }
    flush();
    return groups;
  }

  /** Builds the reasoning disclosure of one assistant entry, empty until reasoning arrives. */
  private buildReasoningDisclosure(index: number, openReasoning: ReadonlySet<string>): {
    disclosure: HTMLDetailsElement;
    body: HTMLDivElement;
  } {
    const disclosure = document.createElement('details');
    disclosure.className = 'reasoning';
    disclosure.open = openReasoning.has(String(index));
    const summary = document.createElement('summary');
    summary.textContent = 'Reasoning';
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    disclosure.append(summary, body);
    return { disclosure, body };
  }

  /** Builds one message item of a single entry: the bubble, the tool cards, or the reasoning disclosure. */
  private buildMessageItem(slot: EntrySlot, openReasoning: ReadonlySet<string>, isStreaming = false): HTMLLIElement {
    const { index, entry } = slot;
    const item = document.createElement('li');
    item.dataset.entryIndex = String(index);
    if (entry.role === 'tool' || (entry.toolName && entry.role !== 'user')) {
      item.append(this.buildToolReplyCard(entry));
      return item;
    }
    if (entry.role === 'assistant' && (entry.reasoning || isStreaming)) {
      // The streaming entry carries the disclosure from the start, so its collapsed state shows before the first reasoning.
      item.className = 'message assistant';
      const { disclosure, body } = this.buildReasoningDisclosure(index, openReasoning);
      body.textContent = entry.reasoning ?? '';
      const text = document.createElement('span');
      text.className = 'message-text';
      text.textContent = entry.content;
      item.append(disclosure, text);
      return item;
    }
    item.className = `message ${entry.role}`;
    item.textContent = entry.content;
    if (entry.images && entry.images.length > 0) {
      item.append(this.buildImageStrip(entry.images));
    }
    return item;
  }

  /** One request/response pair: the framed group card with the labeled request section over the
   * labeled reply section. A missing reply shows the wait hint. */
  private buildToolPair(toolName: string, args: unknown, reply: ChatEntry | null, session?: string): HTMLElement {
    const item = document.createElement('li');
    item.className = 'tool-pair';
    const requestTitle = document.createElement('p');
    requestTitle.className = 'tool-pair-title';
    const requestBadge = document.createElement('span');
    requestBadge.className = 'tool-badge request';
    requestBadge.textContent = '→ Request';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'tool-pair-tool';
    nameLabel.textContent = toolName;
    requestTitle.append(requestBadge, nameLabel);
    if (session) {
      const sessionChip = document.createElement('span');
      sessionChip.className = 'tool-pair-session';
      sessionChip.textContent = session;
      requestTitle.append(sessionChip);
    }
    const requestSection = document.createElement('div');
    requestSection.className = 'tool-pair-section';
    const viewer = document.createElement('json-viewer') as JsonViewerElement;
    viewer.value = args;
    requestSection.append(viewer);
    const replyTitle = document.createElement('p');
    replyTitle.className = 'tool-pair-title';
    const replyBadge = document.createElement('span');
    replyBadge.className = reply && reply.role === 'error' ? 'tool-badge reply error' : 'tool-badge reply';
    replyBadge.textContent = '← Reply';
    replyTitle.append(replyBadge);
    item.append(requestTitle, requestSection, replyTitle);
    if (reply) {
      const replySection = document.createElement('div');
      replySection.className = reply.role === 'error' ? 'tool-pair-section error' : 'tool-pair-section';
      if (reply.json) {
        const replyViewer = document.createElement('json-viewer') as JsonViewerElement;
        replyViewer.value = reply.json;
        replySection.append(replyViewer);
      } else {
        const body = document.createElement('span');
        body.textContent = reply.content;
        replySection.append(body);
      }
      item.append(replySection);
    } else {
      const pending = document.createElement('p');
      pending.className = 'tool-pair-pending';
      pending.textContent = 'waiting for the reply…';
      item.append(pending);
    }
    return item;
  }

  /** The reply half of a pair, or a standalone tool reply: the tool name head over the text or viewer. */
  private buildToolReplyCard(entry: ChatEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = entry.role === 'error' ? 'message tool-result tool-error' : 'message tool-result';
    const head = document.createElement('p');
    head.className = 'tool-result-name';
    head.textContent = entry.toolName ?? 'tool';
    card.append(head);
    if (entry.json) {
      const viewer = document.createElement('json-viewer') as JsonViewerElement;
      viewer.value = entry.json;
      card.append(viewer);
    } else {
      const body = document.createElement('span');
      body.textContent = entry.content;
      card.append(body);
    }
    if (entry.images && entry.images.length > 0) {
      card.append(this.buildImageStrip(entry.images));
    }
    return card;
  }

  /** Builds the thumbnail strip of one entry: one small image per attached picture. */
  private buildImageStrip(images: readonly ChatImage[]): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'image-strip';
    for (const image of images) {
      const thumbnail = document.createElement('img');
      thumbnail.src = `data:${image.mimeType};base64,${image.data}`;
      thumbnail.alt = 'image';
      strip.append(thumbnail);
    }
    return strip;
  }

  /** Appends one agent turn: the intro bubble of the assistant reply, one request/response rail per
   * tool call — paired over the tool call id — and any result that lost its call. */
  private appendAgentTurn(group: Extract<MessageGroup, { kind: 'agent' }>, openReasoning: ReadonlySet<string>): void {
    const entry = group.request.entry;
    if (entry.reasoning || entry.content.length > 0) {
      const intro = document.createElement('li');
      intro.dataset.entryIndex = String(group.request.index);
      intro.className = 'message assistant';
      if (entry.reasoning) {
        // The reasoning of a tool-calling reply stays visible once the turn completes.
        const { disclosure, body } = this.buildReasoningDisclosure(group.request.index, openReasoning);
        body.textContent = entry.reasoning;
        intro.append(disclosure);
      }
      if (entry.content.length > 0) {
        const text = document.createElement('span');
        text.className = 'message-text';
        text.textContent = entry.content;
        intro.append(text);
      }
      this.chatMessages.append(intro);
    }
    const calls = entry.toolCalls ?? [];
    const callIds = new Set(calls.map((call) => call.id));
    const replies = new Map<string, EntrySlot>();
    for (const slot of group.replies) {
      if (slot.entry.toolCallId) {
        replies.set(slot.entry.toolCallId, slot);
      }
    }
    for (const call of calls) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = call.arguments;
      }
      const reply = replies.get(call.id);
      this.chatMessages.append(this.buildToolPair(call.name, args, reply ? reply.entry : null));
    }
    for (const slot of group.replies) {
      if (slot.entry.toolCallId && callIds.has(slot.entry.toolCallId)) {
        continue;
      }
      const item = document.createElement('li');
      item.append(this.buildToolReplyCard(slot.entry));
      this.chatMessages.append(item);
    }
  }

  private renderMessages(): void {
    // An open reasoning disclosure stays open across the rebuild, keyed by the entry index.
    const openReasoning = new Set<string>();
    for (const item of this.chatMessages.children) {
      if (!(item instanceof HTMLElement)) {
        continue;
      }
      const key = item.dataset.entryIndex;
      if (!key) {
        continue;
      }
      const disclosure = item.querySelector(':scope > details.reasoning');
      if (disclosure instanceof HTMLDetailsElement && disclosure.open) {
        openReasoning.add(key);
      }
    }
    this.chatMessages.replaceChildren();
    const chat = this.activeChat();
    if (!chat) {
      return;
    }
    // The last assistant entry of a busy chat streams: it carries the reasoning disclosure from the start.
    const streamingIndex = this.chatSend.disabled ? chat.entries.length - 1 : -1;
    for (const group of this.groupChatEntries(chat)) {
      if (group.kind === 'single') {
        this.chatMessages.append(this.buildMessageItem(group.slot, openReasoning, group.slot.index === streamingIndex));
        continue;
      }
      if (group.kind === 'agent') {
        this.appendAgentTurn(group, openReasoning);
        continue;
      }
      const reply = group.reply ? group.reply.entry : null;
      this.chatMessages.append(
        this.buildToolPair(
          group.request.entry.toolName ?? group.request.entry.content,
          group.request.entry.json,
          reply,
          group.request.entry.mcpSession,
        ),
      );
    }
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }
}
