/**
 * The main app screen: a tab bar with a fixed settings tab first, then the chat tabs.
 * The settings pane shows the workspace facts and edits the provider settings.
 * A chat pane sends its conversation through the configured provider and shows the reply.
 */

import { OpenAiInferenceProvider } from '../providers/openai.js';
import type { ChatImage, ChatMessage, CompletionDelta, ThinkingLevel, ToolCall } from '../providers/provider.js';
import type { StorageSetup, SystemPromptSetup } from './plugins.js';
import type { McpEndpoint, McpEndpoints } from '../shared/mcp-endpoints.js';
import { sanitizeEndpointLabel } from '../shared/mcp-endpoints.js';
import { closeWindow, minimizeWindow } from './window-ops.js';
import { AppRail } from './rail.js';
import { installColumnResizers } from './chat-resizer.js';
import { getWorkarea } from './workarea.js';
import type {
  ModelEntry,
  ProviderAccount,
  ProviderRegistry,
  WorkspaceSettings,
} from '../shared/workspace.js';
import { emptyProviderRegistry } from '../shared/workspace.js';
import { presetOfAccount, PROVIDER_PRESETS } from '../shared/provider-presets/index.js';
import { readBridge } from '../shared/bridge.js';
import {
  agentToolDefinition,
  agentToolRule,
  availableAgentTools,
  buildAgentTools,
  CHAT_AGENT_SOURCE,
  type AgentTool,
  type AgentToolDeps,
  type AgentToolOutput,
} from './agent-tools.js';
import { type ChatSessionStore, type ChatEntry, type StoredChatSession, type StoredSystemPrompt } from './chat-sessions.js';
import { JsonViewerElement } from './json-viewer-element.js';
import type { McpClientSurface } from './mcp-client-adapter.js';
import type { McpConnectionInfo, McpHostHandle, McpSessionSink } from '../shared/window-tools.js';
import type { NotificationHub } from './notification-hub.js';
import type { PermissionGate } from './permission-gate.js';
import { PermissionRequestElement, type PermissionResolveDetail } from './permission-request-element.js';
import { PluginFieldGroup } from './plugin-fields.js';
import { requireElement } from './dom.js';
import type { WorkspaceSettingsStore } from './settings-store.js';
import {
  EMPTY_SHARED_STORAGES,
  type StorageShareRegistry,
  type SharedStoragesRecord,
  type StorageAccess,
  type SharedStorageEntry,
} from './storage-shares.js';
import { applyTheme, resolveThemeId, THEMES } from './theme.js';
import { FRAME_MODES, resolveFrameMode } from './frame-mode.js';
import type { PluginFolderController } from './plugin-folders.js';
import { defaultSystemPromptSetup, NONE_SYSTEM_PROMPT_SETUP_ID } from './system-prompts.js';

/** The longest edge of a pasted or dropped image, in pixels. Bigger pictures scale down. */
const MAX_IMAGE_EDGE = 1280;

/** How many images one chat message may carry. */
const MAX_ATTACHMENTS = 4;

/** How far from the bottom, in pixels, the chat still counts as pinned to the latest message. */
const CHAT_PIN_THRESHOLD = 8;

/** How long the collapsed reasoning tail stays after the last reasoning delta, in milliseconds. */
const REASONING_TAIL_TIMEOUT = 1200;

/** The icon strokes of the message action zone, drawn on a 16 by 16 grid. */
const ICON_COPY = 'M6 6h8v8H6z M12 3H2v9';
const ICON_EDIT = 'M2 14h3L14 5l-3-3L2 11z';
const ICON_FORK = 'M4 14V2 M4 7c4 0 8-2 8-5 M4 9c4 0 8 2 8 5';
const ICON_RETRY = 'M13 8a5 5 0 11-1.5-3.5 M12.5 1.5v3h3';
/** The icon strokes of the streaming status line, drawn on a 16 by 16 grid. */
const ICON_CONNECTING = 'M13 8a5 5 0 11-1.5-3.5';
const ICON_ERROR = 'M4 4l8 8 M12 4l-8 8';

/** Reads the trailing words of a reasoning text, for the collapsed activity tail. */
function reasoningTailOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 80) {
    return flat;
  }
  const cut = flat.slice(-80);
  const firstSpace = cut.indexOf(' ');
  return firstSpace >= 0 ? cut.slice(firstSpace + 1) : cut;
}

/** Reads the one or two words that title an error, from the message the provider produced. */
function errorLabelOf(message: string): string {
  if (message.includes('could not reach')) {
    return 'Unreachable';
  }
  const status = /answered HTTP (\d+)/.exec(message);
  if (status?.[1]) {
    return `HTTP ${status[1]}`;
  }
  return 'Failed';
}

/** Reads the image files out of one clipboard or drag file list. */
function imageFilesOf(files: FileList | null): readonly File[] {
  if (!files) {
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
  // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real count, only absence shows the dash
  if (count === undefined) {
    return '–';
  }
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** One chat tab with its conversation. */
interface Chat {
  readonly id: number;
  /** The session file id: one uuid per chat, stable across launches. */
  readonly fileId: string;
  readonly title: string;
  /** ISO date and time of the chat creation. It fixes the restore order. */
  readonly createdAt: string;
  readonly entries: ChatEntry[];
  /** True when this tab is the one MCP host tab that logs every session. */
  readonly isMcpHostLog?: boolean;
  /** True while the tab sits in the background and took traffic the user has not seen. */
  unread?: boolean;
  /** The system prompt source the menu holds while the chat has sent no message. */
  pendingSystemPromptId?: string;
  /** The system prompt the chat bound on its first send. It stays for the life of the chat. */
  boundSystemPrompt?: StoredSystemPrompt;
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
  /** The reasoning effort of this chat. Unset follows the workspace default. */
  thinkingLevel?: ThinkingLevel;
}

/** One render slot: an entry with its list index, the key of the reasoning open-state. */
interface EntrySlot {
  readonly index: number;
  readonly entry: ChatEntry;
}

/** One render group of the message list: one entry, an MCP request with its reply, or one agent
 * turn: the tool calls of an assistant reply with the tool results that answer them. */
type MessageGroup =
  | { readonly kind: 'single'; readonly slot: EntrySlot } |
  { readonly kind: 'pair'; readonly request: EntrySlot; readonly reply: EntrySlot | null } |
  { readonly kind: 'agent'; readonly request: EntrySlot; readonly replies: readonly EntrySlot[] };

/** Drives the main app screen. */
export class MainApp implements McpSessionSink {
  private readonly settings: WorkspaceSettings;
  private readonly store: WorkspaceSettingsStore;
  private readonly storageLabel: string;
  private readonly permissionGate: PermissionGate | null;
  private readonly mcpClients: McpClientSurface;
  private readonly notificationHub: NotificationHub;
  private readonly workspacePath: string;
  private readonly storageShares: StorageShareRegistry;
  private readonly storageSetups: readonly StorageSetup[];
  private readonly chatSessions: ChatSessionStore;
  private readonly promptSources: readonly SystemPromptSetup[];
  private readonly pluginFolders: PluginFolderController;
  private mcpHost: McpHostHandle | null = null;
  private registry: ProviderRegistry = emptyProviderRegistry();
  private mcpEndpoints: McpEndpoints = { endpoints: [] };
  private sharedStorages: SharedStoragesRecord = EMPTY_SHARED_STORAGES;
  private readonly chats: Chat[] = [];
  private activeChatId: number | null = null;
  private nextChatId = 1;
  /** True while the settings view fills the center workspace. The chat column stays beside it. */
  private settingsOpen = false;
  /** The left rail: the approvals feed and the files tree. */
  private rail: AppRail | null = null;
  /** The chat of the running agent turn, so a waiting approval row opens the tab that holds its card. */
  private agentTurnChatId: number | null = null;
  /** The images that ride along with the next message, from paste or drop. */
  private pendingImages: ChatImage[] = [];
  /** True while the chat view sits at the latest message, so new content keeps it in view. */
  private chatPinned = true;
  /** The pending clear of the collapsed reasoning tail, armed on every reasoning delta. */
  private reasoningTailTimer: number | null = null;
  /** True while the agent runs one turn. A send while busy queues the message instead. */
  private chatBusy = false;
  /** The abort controller of the running agent turn, or null while idle. */
  private chatAbort: AbortController | null = null;
  /** How many provider rounds one message may spend on tool calls. Null means no limit. */
  private agentTurnLimit: number | null = null;
  /** The default reasoning effort of the chats. Null means the endpoint default. */
  private agentThinkingDefault: ThinkingLevel | null = null;
  /** The one open message editor: the chat it belongs to, the entry index it replaces, and its draft.
   * A missing index marks the draft of a fork, which appends as a new message at the end. */
  private editing: {
    readonly chatId: number;
    readonly index?: number;
    readonly text: string;
    readonly images?: readonly ChatImage[];
  } | null = null;

  private readonly appSettings = requireElement<HTMLButtonElement>('#app-settings');
  private readonly chatTabs = requireElement<HTMLElement>('#chat-tab-list');
  private readonly newChatButton = requireElement<HTMLButtonElement>('#new-chat');
  private readonly paneSettings = requireElement<HTMLElement>('#pane-settings');
  private readonly paneChat = requireElement<HTMLElement>('#pane-chat');
  private readonly chatMessages = requireElement<HTMLOListElement>('#chat-messages');
  private readonly chatForm = requireElement<HTMLFormElement>('#chat-form');
  private readonly chatInput = requireElement<HTMLTextAreaElement>('#chat-input');
  private readonly chatAttachments = requireElement<HTMLElement>('#chat-attachments');
  private readonly chatJumpDown = requireElement<HTMLButtonElement>('#chat-jump-down');
  private readonly chatSend = requireElement<HTMLButtonElement>('#chat-send');
  private readonly chatStop = requireElement<HTMLButtonElement>('#chat-stop');
  private readonly chatStatus = requireElement<HTMLElement>('#chat-status');
  private readonly providerList = requireElement<HTMLElement>('#provider-list');
  private readonly providerAdd = requireElement<HTMLDetailsElement>('#provider-add');
  private readonly providerAddForm = requireElement<HTMLFormElement>('#provider-add-form');
  private readonly providerAddPreset = requireElement<HTMLSelectElement>('#provider-add-preset');
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
  private readonly agentToolList = requireElement<HTMLElement>('#agent-tool-list');
  private readonly pluginFolderList = requireElement<HTMLElement>('#plugin-folder-list');

  /**
   * @param settings The workspace settings.
   * @param store The settings store of the workspace.
   * @param storageLabel The display label of the storage the workspace uses.
   * @param permissionGate The permission gate of the workspace, or null before one exists.
   * @param mcpClients The MCP client manager of the workspace.
   * @param notificationHub The notification hub of the workspace.
   * @param workspacePath The absolute path of the workspace directory.
   * @param storageShares The storage sharing registry of the workspace.
   * @param storageSetups The registered storage setups, for the add form.
   * @param chatSessions The chat session store of the workspace.
   * @param promptSources The registered system prompt sources, for the chat menu.
   * @param pluginFolders The plugin folder controller, for the settings pane.
   */
  constructor(
    settings: WorkspaceSettings,
    store: WorkspaceSettingsStore,
    storageLabel: string,
    permissionGate: PermissionGate | null,
    mcpClients: McpClientSurface,
    notificationHub: NotificationHub,
    workspacePath: string,
    storageShares: StorageShareRegistry,
    storageSetups: readonly StorageSetup[],
    chatSessions: ChatSessionStore,
    promptSources: readonly SystemPromptSetup[],
    pluginFolders: PluginFolderController,
  ) {
    this.settings = settings;
    this.store = store;
    this.storageLabel = storageLabel;
    this.permissionGate = permissionGate;
    this.mcpClients = mcpClients;
    this.notificationHub = notificationHub;
    this.workspacePath = workspacePath;
    this.storageShares = storageShares;
    this.storageSetups = storageSetups;
    this.chatSessions = chatSessions;
    this.promptSources = promptSources;
    this.pluginFolders = pluginFolders;
    this.notificationHub.setChatNotifier((text) => {
      this.pushChatNotification(text);
    });
  }

  /**
   * Loads the provider settings, restores the stored chat sessions, and wires the events.
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
      this.renderAgentTools();
    });
    requireElement<HTMLElement>('#workspace-name').textContent = this.settings.name;
    requireElement<HTMLElement>('#workspace-storage-mode').textContent = `Setting storage: ${this.storageLabel}`;
    try {
      this.registry = await this.store.loadProviderRegistry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] could not read the provider registry: ${message}`);
    }
    this.syncProviderCors();
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
      this.renderAgentTools();
    });
    this.storageShares.applyRecord(this.sharedStorages);
    await this.initializeThemeControls();
    await this.initializeFrameControls();
    await this.initializeAgentTurnControls();
    this.initializeMcpHostSection();
    this.initializeMcpEndpointsSection();
    this.initializeStorageShareSection();
    // The gate loads its rules lazily on the first check. The rule-reading UI renders before any
    // check runs, so it must await the load or it reads an empty list and shows every tool on ask.
    await this.permissionGate?.ready();
    this.rail = new AppRail({
      gate: this.permissionGate,
      workspacePath: this.workspacePath,
      openTab: (source) => {
        this.openPermissionTab(source);
      },
    });
    this.rail.start();
    await this.seedAgentToolDefaults();
    // The direct render covers a launch that seeds nothing and fires no gate or connection event.
    this.renderAgentTools();
    this.renderPluginFolders();
    this.initializeProviderSection();
    requireElement<HTMLButtonElement>('#app-close').addEventListener('click', () => {
      void closeWindow();
    });
    requireElement<HTMLButtonElement>('#app-minimize').addEventListener('click', () => {
      void minimizeWindow();
    });
    this.appSettings.addEventListener('click', () => {
      this.toggleSettings();
    });
    installColumnResizers();
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
    // Enter sends; Shift+Enter and Ctrl+Enter break the line. A composing input method keeps its Enter.
    this.chatInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.shiftKey || event.isComposing) {
        return;
      }
      event.preventDefault();
      this.chatForm.requestSubmit();
    });
    this.chatInput.addEventListener('input', () => {
      this.fitChatInput();
    });
    this.chatStop.addEventListener('click', () => {
      this.chatAbort?.abort();
    });
    // The chat view scrolls to the latest message only while it sits at the bottom.
    // A scroll away from the end unpins it, and the arrow above the input jumps back.
    this.chatMessages.addEventListener('scroll', () => {
      this.updateChatPinned();
    });
    this.chatJumpDown.addEventListener('click', () => {
      this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
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
    await this.chatSessions.init();
    await this.restoreChats();
  }

  /** Restores the stored sessions as chat tabs in creation order and activates the newest.
   * A workspace without a stored session opens one fresh chat. */
  private async restoreChats(): Promise<void> {
    const sessions = await this.chatSessions.loadSessions();
    for (const session of sessions) {
      const chat: Chat = {
        id: this.nextChatId,
        fileId: session.id,
        title: session.title,
        createdAt: session.createdAt,
        entries: [...session.entries],
        ...(session.boundProviderId ? { boundProviderId: session.boundProviderId } : {}),
        ...(session.boundModel ? { boundModel: session.boundModel } : {}),
        // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence drops the field
        ...(session.contextTokens !== undefined ? { contextTokens: session.contextTokens } : {}),
        // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence drops the field
        ...(session.outputTokens !== undefined ? { outputTokens: session.outputTokens } : {}),
        ...(session.systemPrompt ? { boundSystemPrompt: session.systemPrompt } : {}),
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      };
      this.nextChatId += 1;
      this.chats.push(chat);
    }
    // The id counter also names new chats. A closed chat drops its file, so a restored title
    // can carry a number above the session count, and the counter must clear it.
    const highestChatNumber = Math.max(0, ...this.chats.map((chat) => Number(/^Chat (\d+)$/.exec(chat.title)?.[1] ?? 0)));
    this.nextChatId = Math.max(this.nextChatId, highestChatNumber + 1);
    const newest = this.chats.at(-1) ?? null;
    if (!newest) {
      this.newChat();
      return;
    }
    this.activateChat(newest.id);
  }

  /** Persists one chat as its session file. The host tab and chats without entries hold nothing worth a file. */
  private persistChat(chat: Chat): void {
    if (chat.isMcpHostLog || chat.entries.length === 0) {
      return;
    }
    const session: StoredChatSession = {
      id: chat.fileId,
      title: chat.title,
      createdAt: chat.createdAt,
      entries: chat.entries,
      ...(chat.boundProviderId ? { boundProviderId: chat.boundProviderId } : {}),
      ...(chat.boundModel ? { boundModel: chat.boundModel } : {}),
      // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence drops the field
      ...(chat.contextTokens !== undefined ? { contextTokens: chat.contextTokens } : {}),
      // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence drops the field
      ...(chat.outputTokens !== undefined ? { outputTokens: chat.outputTokens } : {}),
      ...(chat.boundSystemPrompt ? { systemPrompt: chat.boundSystemPrompt } : {}),
      ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
    };
    this.chatSessions.saveSession(session);
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
      console.warn(`[NodeWavenUI] the agent tool defaults could not be seeded: ${message}`);
    }
  }

  /** Renders the agent tools section: one group head per origin, one row per tool with its state. */
  private renderAgentTools(): void {
    this.agentToolList.replaceChildren();
    const gate = this.permissionGate;
    const rules = gate?.listRules() ?? [];
    const tools = availableAgentTools(this.agentToolDeps());
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

  /** The group head of one tool: the built-ins, the window tools, or the endpoint label of a native tool. */
  private toolOriginLabel(name: string): string {
    if (name === 'read' || name === 'evaluate') {
      return 'Built-in tools';
    }
    const separator = name.indexOf('.');
    if (separator > 0) {
      const prefix = name.slice(0, separator);
      const endpoint = this.mcpEndpoints.endpoints.find(
        (candidate) => sanitizeEndpointLabel(candidate.label) === prefix,
      );
      return endpoint?.label ?? 'MCP tools';
    }
    return 'Window tools';
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
      console.warn(`[NodeWavenUI] the state of the tool "${name}" could not be saved: ${message}`);
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
          if (suffix !== null && toolNames.includes(suffix)) {
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
          console.warn(`[NodeWavenUI] the tool rules of "${old.label}" could not move to "${endpoint.label}": ${message}`);
        }
      }
    }
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
      // The host tab holds the id 0, below every chat number, so it consumes no chat title.
      id: 0,
      fileId: crypto.randomUUID(),
      title: 'MCP Host',
      createdAt: new Date().toISOString(),
      entries: [],
      isMcpHostLog: true,
    };
    this.chats.unshift(chat);
    this.activateChat(chat.id);
    return chat;
  }

  /** McpSessionSink: one tool call of a session lands in the host tab, its arguments in the JSON viewer. */
  toolCall(sessionId: string, toolName: string, args: Record<string, unknown>): void {
    this.appendMcpEntry(sessionId, 'user', toolName, args, toolName);
  }

  /** McpSessionSink: one tool result of a session lands in the host tab, a JSON reply in the viewer, an image reply as thumbnails. */
  toolResult(
    sessionId: string,
    toolName: string,
    summary: string,
    isError: boolean,
    json?: unknown,
    images?: readonly ChatImage[],
  ): void {
    this.appendMcpEntry(sessionId, isError ? 'error' : 'assistant', summary, json, toolName, images);
  }

  /** McpSessionSink: one notification a client sent the host reaches the hub. */
  clientNotification(sessionId: string, method: string, params: unknown): void {
    this.notificationHub.dispatch(method, params, `host-session ${sessionId.slice(0, 8)}`);
  }

  private appendMcpEntry(sessionId: string, role: ChatEntry['role'], content: string, json?: unknown, toolName?: string, images?: readonly ChatImage[]): void {
    const chat = this.mcpHostTab() ?? this.createMcpHostTab();
    chat.entries.push({
      role,
      content,
      ...(json ? { json } : {}),
      ...(toolName ? { toolName } : {}),
      ...(images && images.length > 0 ? { images } : {}),
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
    this.persistChat(chat);
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
        this.rail?.noteResolution(detail.id, detail.approve);
        void gate.resolveRequest(detail.id, detail.approve, detail.remember);
      });
      this.permissionRequests.append(card);
    }
    if (requests.length === 0 && all.length > 0) {
      const notice = document.createElement('p');
      notice.className = 'permission-request-waiting';
      notice.textContent = hostTabActive ?
        'A permission request waits in a chat tab. Open the tab to answer it.' :
        'A permission request waits in the MCP Host tab. Open the tab to answer it.';
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

  /** Loads the agent round limit and thinking default of the workspace and wires the dropdowns of the settings pane. */
  private async initializeAgentTurnControls(): Promise<void> {
    try {
      this.agentTurnLimit = await this.store.loadAgentTurnLimit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored agent round limit could not be read, no limit applies: ${message}`);
    }
    const turnsSelect = requireElement<HTMLSelectElement>('#agent-turns-select');
    turnsSelect.value = this.agentTurnLimit ? String(this.agentTurnLimit) : '';
    turnsSelect.addEventListener('change', () => {
      const value = Number(turnsSelect.value);
      this.agentTurnLimit = turnsSelect.value === '' ? null : value;
      this.store.saveAgentTurnLimit(this.agentTurnLimit).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the agent round limit could not be saved: ${message}`);
      });
    });
    try {
      this.agentThinkingDefault = await this.store.loadAgentThinking();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the stored agent thinking default could not be read, the endpoint default applies: ${message}`);
    }
    const thinkingSelect = requireElement<HTMLSelectElement>('#agent-thinking-select');
    thinkingSelect.value = this.agentThinkingDefault ?? '';
    thinkingSelect.addEventListener('change', () => {
      const value = thinkingSelect.value;
      this.agentThinkingDefault = value === 'low' || value === 'medium' || value === 'high' ? value : null;
      this.store.saveAgentThinking(this.agentThinkingDefault).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the agent thinking default could not be saved: ${message}`);
      });
    });
  }

  /** Renders the provider cards. The add form is a collapsed disclosure below the list. */
  private initializeProviderSection(): void {
    this.renderProviders();
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

  /** Registers the base URLs of the registry with the CORS filter of the main process, so the
   * provider fetch of the sandboxed page passes the preflight its endpoints do not answer. */
  private syncProviderCors(): void {
    readBridge()?.workspace
      .allowProviderCors(this.registry.accounts.map((account) => account.baseUrl))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] the provider CORS allowlist could not be registered: ${message}`);
      });
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
    if (!modelId) {
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
    this.syncProviderCors();
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
      ...(this.providerAddPreset.value ? { presetId: this.providerAddPreset.value } : {}),
      models: [],
    };
    this.providerAddPreset.value = '';
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
    const isDefaultAccount = this.effectiveDefaultAccount()?.id === account.id;
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
    return this.registry.accounts.find((account) => account.id === id) ?? null;
  }

  /** Rewrites one account in the registry. */
  private withAccount(id: string, rewrite: (account: ProviderAccount) => ProviderAccount, successText: string): void {
    const account = this.accountById(id);
    if (!account) {
      return;
    }
    this.persistRegistry(
      {
        ...this.registry,
        accounts: this.registry.accounts.map((candidate) => (candidate.id === id ? rewrite(candidate) : candidate)),
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
        accounts: this.registry.accounts.map((candidate) =>
          candidate.id === id ? { ...candidate, models } : candidate,
        ),
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
      chat.pendingModel && account.models.some((candidate) => candidate.id === chat.pendingModel) ?
        chat.pendingModel :
        this.effectiveDefaultModel(account);
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
    if (!chat || (text.length === 0 && images.length === 0)) {
      return;
    }
    if (this.chatBusy) {
      // The agent runs: the message waits as a dimmed entry and delivers when the run ends.
      this.chatInput.value = '';
      this.fitChatInput();
      this.pendingImages = [];
      this.renderAttachments();
      chat.entries.push({ role: 'user', content: text, ...(images.length > 0 ? { images: [...images] } : {}), queued: true });
      this.renderMessages();
      return;
    }
    // The user acts on the latest message, so the send pins the view back to it.
    this.chatPinned = true;
    await this.deliver(chat, text, images);
  }

  /** True when the chat already carries a sent message, so its system prompt window has passed. */
  private chatHasConversation(chat: Chat): boolean {
    return chat.entries.some((entry) => entry.role === 'user' || entry.role === 'assistant');
  }

  /** True while a chat sits before its first sent message, so its system prompt window is open. */
  private chatNeedsSystemPrompt(chat: Chat): boolean {
    return !chat.boundSystemPrompt && !this.chatHasConversation(chat);
  }

  /** Binds the system prompt of a chat that sits before its first message: the menu choice snapshots
   * its text into the chat, so the chat keeps what it sent. A chat that picks no source binds the
   * none prompt.
   *
   * @returns True when the chat holds a prompt. False when the source build failed; its error entry landed.
   */
  private async bindChatSystemPrompt(chat: Chat): Promise<boolean> {
    const setup = this.selectedSystemPromptSetup(chat);
    if (!setup) {
      chat.boundSystemPrompt = { sourceId: NONE_SYSTEM_PROMPT_SETUP_ID, title: 'No system prompt', text: '' };
      return true;
    }
    let promptText: string;
    try {
      promptText = await setup.build({ workspacePath: this.workspacePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chat.entries.push({
        role: 'error',
        content: `The system prompt source "${setup.label}" failed: ${message}`,
      });
      this.renderMessages();
      return false;
    }
    chat.boundSystemPrompt = { sourceId: setup.id, title: setup.label, text: promptText };
    this.renderMessages();
    return true;
  }

  /** Delivers one message: resolves the connection, binds the system prompt, pushes the entry, and runs the agent turn. */
  private async deliver(chat: Chat, text: string, images: readonly ChatImage[]): Promise<void> {
    const connection = this.resolveChatConnection(chat);
    if (connection && images.length > 0 && !connection.vision) {
      // Nothing is consumed: the text stays typed and the chips stay pending, so the user can switch model or remove the images.
      chat.entries.push({
        role: 'notice',
        content: `The model "${connection.model}" reads text only. Turn on its Vision flag in the settings, or remove the images.`,
      });
      this.renderMessages();
      this.persistChat(chat);
      return;
    }
    // Only a chat without messages binds a prompt. An old chat keeps running without one.
    // The bind sits past the rejected-send guards, so a send that never reaches the transcript leaves the menu open.
    if (this.chatNeedsSystemPrompt(chat)) {
      // The first send binds the prompt source and snapshots its text, so the chat keeps what it sent.
      if (!(await this.bindChatSystemPrompt(chat))) {
        return;
      }
    }
    this.chatInput.value = '';
    this.fitChatInput();
    this.pendingImages = [];
    this.renderAttachments();
    chat.entries.push({ role: 'user', content: text, ...(images.length > 0 ? { images } : {}) });
    await this.runChatTurn(chat);
  }

  /** Runs one agent turn that answers the latest user message of the chat: resolves the connection,
   * streams the reply, records the outcome, and delivers the queue.
   * The send, the retry of a failed turn, and the resend of an edited message all land here. */
  private async runChatTurn(chat: Chat): Promise<void> {
    const connection = this.resolveChatConnection(chat);
    if (!connection) {
      chat.entries.push({
        role: chat.boundProviderId ? 'error' : 'notice',
        content: chat.boundProviderId ?
          'The provider of this chat no longer exists. Open a new chat tab for a different model.' :
          'No provider is configured. Open the Settings tab, add a provider, and give it a model.',
      });
      this.renderMessages();
      this.persistChat(chat);
      return;
    }
    const preset = presetOfAccount(connection.account);
    const provider = new OpenAiInferenceProvider({
      baseUrl: connection.account.baseUrl,
      apiKey: connection.account.apiKey,
      ...(preset?.beforeRequest ? { beforeRequest: preset.beforeRequest } : {}),
    });
    if (!chat.boundProviderId) {
      // The first send binds the chat to this provider and model, and locks the status bar.
      chat.boundProviderId = connection.account.id;
      chat.boundModel = connection.model;
      this.renderChatStatus();
    }
    const abort = new AbortController();
    this.chatAbort = abort;
    this.agentTurnChatId = chat.id;
    this.setChatBusy(true);
    this.renderMessages();
    let stopped = false;
    try {
      await this.runAgentTurn(
        chat,
        provider,
        connection.model,
        connection.vision,
        this.agentTurnLimit,
        chat.thinkingLevel ?? this.agentThinkingDefault ?? undefined,
        abort.signal,
      );
    } catch (error) {
      if (abort.signal.aborted) {
        stopped = true;
        // The aborted streaming slot keeps whatever streamed. An empty one drops, queued entries included in the search.
        for (let index = chat.entries.length - 1; index >= 0; index -= 1) {
          const candidate = chat.entries[index];
          if (candidate && candidate.role === 'assistant') {
            if (!candidate.content && !candidate.reasoning && !candidate.toolCalls) {
              chat.entries.splice(index, 1);
            }
            break;
          }
        }
        chat.entries.push({ role: 'notice', content: 'Stopped.' });
      } else {
        chat.entries.push({
          role: 'error',
          content: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.chatAbort = null;
      this.agentTurnChatId = null;
      this.setChatBusy(false);
      this.renderMessages();
      this.persistChat(chat);
    }
    // A stop leaves the queue in place: the user halted the agent, so nothing follows on its own.
    if (stopped) {
      return;
    }
    await this.drainQueued(chat);
  }

  /** Restarts the failed turn of one user message: every entry after the message drops, and the
   * turn runs again, so the failed message sends again from that exact point. */
  private async retryChatFrom(chat: Chat, messageIndex: number): Promise<void> {
    if (this.chatBusy) {
      return;
    }
    chat.entries.splice(messageIndex + 1);
    this.chatPinned = true;
    this.renderMessages();
    await this.runChatTurn(chat);
  }

  /** Copies the history before one user message into a new chat tab, then opens the message editor
   * there with the original text. The source chat keeps its whole conversation. */
  private forkChatAt(chat: Chat, index: number): void {
    const original = chat.entries[index];
    if (!original) {
      return;
    }
    const fork: Chat = {
      id: this.nextChatId,
      fileId: crypto.randomUUID(),
      title: `${chat.title} fork`,
      createdAt: new Date().toISOString(),
      entries: chat.entries.slice(0, index).map((entry) => ({ ...entry })),
      ...(chat.boundProviderId ? { boundProviderId: chat.boundProviderId } : {}),
      ...(chat.boundModel ? { boundModel: chat.boundModel } : {}),
      ...(chat.boundSystemPrompt ? { boundSystemPrompt: chat.boundSystemPrompt } : {}),
      ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
    };
    this.nextChatId += 1;
    this.chats.push(fork);
    this.editing = {
      chatId: fork.id,
      text: original.content,
      ...(original.images && original.images.length > 0 ? { images: original.images } : {}),
    };
    this.activateChat(fork.id);
  }

  /** Sends the edited draft: the history from the edited message on drops, the draft replaces the
   * message, and the turn restarts from there. A fork draft appends to the copied history. */
  private async saveEditing(): Promise<void> {
    const editing = this.editing;
    const editor = this.chatMessages.querySelector('textarea.message-editor');
    if (!editing || !(editor instanceof HTMLTextAreaElement)) {
      return;
    }
    const text = editor.value.trim();
    const chat = this.chats.find((candidate) => candidate.id === editing.chatId) ?? null;
    this.editing = null;
    if (!chat || this.chatBusy) {
      this.renderMessages();
      return;
    }
    const target = typeof editing.index === 'number' ? chat.entries[editing.index] : undefined;
    const images = editing.images ?? target?.images ?? [];
    if (text.length === 0 && images.length === 0) {
      this.renderMessages();
      return;
    }
    if (this.chatNeedsSystemPrompt(chat)) {
      // A fork draft at the head of its tab is a first message, so the menu choice binds here too.
      if (!(await this.bindChatSystemPrompt(chat))) {
        return;
      }
    }
    chat.entries.splice(editing.index ?? chat.entries.length);
    chat.entries.push({ role: 'user', content: text, ...(images.length > 0 ? { images } : {}) });
    this.chatPinned = true;
    this.renderMessages();
    await this.runChatTurn(chat);
  }

  /** Copies one message text to the clipboard. */
  private copyEntryText(text: string): void {
    navigator.clipboard.writeText(text).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the message text could not be copied: ${message}`);
    });
  }

  /** Delivers the first queued message of a chat after a finished run. The entry moves to the end as it delivers. */
  private async drainQueued(chat: Chat): Promise<void> {
    const index = chat.entries.findIndex((entry) => entry.role === 'user' && entry.queued);
    const queued = index >= 0 ? chat.entries[index] : undefined;
    if (!queued) {
      return;
    }
    chat.entries.splice(index, 1);
    this.renderMessages();
    await this.deliver(chat, queued.content, queued.images ?? []);
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
    if (!context) {
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

  /** The dependencies the agent tools build from. The rule reader feeds the tool rule layer. */
  private agentToolDeps(): AgentToolDeps {
    return {
      gate:
        this.permissionGate ?? {
          check: async () => {
            throw new Error('No permission gate is wired.');
          },
        },
      mcpClients: this.mcpClients,
      workspacePath: this.workspacePath,
      storageShares: this.storageShares,
      toolRules: () => this.permissionGate?.listRules() ?? [],
    };
  }

  /** The tools the agent may call this turn, the built-ins plus the native MCP tools, without the disabled ones. */
  private agentTools(): readonly AgentTool[] {
    return buildAgentTools(this.agentToolDeps());
  }

  /** Runs the tool-calling loop of one user message, until the model answers in text or hits the round limit. */
  private async runAgentTurn(
    chat: Chat,
    provider: OpenAiInferenceProvider,
    model: string,
    vision: boolean,
    limit: number | null,
    thinkingLevel: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let turn = 0;
    while (limit === null || turn < limit) {
      turn += 1;
      const tools = this.agentTools();
      const messages = this.agentMessages(chat, vision);
      const streaming = this.beginStreamingEntry(chat);
      const result = await provider.complete({
        model,
        messages,
        tools: tools.map(agentToolDefinition),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        onDelta: streaming.onDelta,
        signal,
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
      content: `The agent exceeded ${limit} tool rounds in one message.`,
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
    // The turn runs on, so the result lands in the session file now: a crash mid-turn keeps it.
    this.persistChat(chat);
  }

  /** Reads the entries of one chat as the message list of the next provider request. */
  private agentMessages(chat: Chat, vision: boolean): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const system = chat.boundSystemPrompt;
    if (system && system.sourceId !== NONE_SYSTEM_PROMPT_SETUP_ID && system.text.length > 0) {
      messages.push({ role: 'system', content: system.text });
    }
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
        if (entry.queued) {
          continue;
        }
        flushToolImages();
        messages.push({
          role: 'user',
          content: entry.content,
          ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
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
   * The entry is tracked by identity, because a message queued mid-run appends after it.
   * The renders stay throttled, so a long stream does not thrash the message list.
   */
  private beginStreamingEntry(chat: Chat): {
    onDelta: (delta: CompletionDelta) => void;
    settle: (entry: ChatEntry) => void;
  } {
    let liveContent = '';
    let liveReasoning = '';
    // The slot is tracked through its replacements, because a message queued mid-run appends after it.
    let slot: ChatEntry = { role: 'assistant', content: '' };
    chat.entries.push(slot);
    const replaceSlot = (next: ChatEntry): void => {
      const index = chat.entries.indexOf(slot);
      if (index >= 0) {
        chat.entries[index] = next;
        slot = next;
      }
    };
    let lastStreamRender = 0;
    const renderStreamed = (force: boolean): void => {
      const now = Date.now();
      if (force || now - lastStreamRender >= 80) {
        lastStreamRender = now;
        this.patchStreamingEntry(chat, slot);
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
        replaceSlot({
          role: 'assistant',
          content: liveContent,
          ...(liveReasoning.length > 0 ? { reasoning: liveReasoning } : {}),
        });
        renderStreamed(false);
      },
      settle: (entry: ChatEntry): void => {
        replaceSlot(entry);
        this.renderMessages();
      },
    };
  }

  /**
   * Patches the streaming entry into the live list item instead of rebuilding the whole list,
   * so a click or an open disclosure never fights the stream renders.
   * A missing or replaced list item falls back to one full render.
   */
  private patchStreamingEntry(chat: Chat, slot: ChatEntry): void {
    const index = chat.entries.indexOf(slot);
    const entry = index >= 0 ? chat.entries[index] : undefined;
    const item = this.chatMessages.querySelector(`:scope > li[data-entry-index="${index}"]`);
    if (!entry || entry.role !== 'assistant' || !(item instanceof HTMLElement)) {
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
    const reasoning = entry.reasoning ?? '';
    body.textContent = reasoning;
    const tail = item.querySelector(':scope > details.reasoning > summary > .reasoning-tail');
    if (reasoning && tail instanceof HTMLElement) {
      tail.textContent = reasoningTailOf(reasoning);
      if (this.reasoningTailTimer) {
        window.clearTimeout(this.reasoningTailTimer);
      }
      // Reasoning that stops mid-stream clears its tail, and the settled render drops it entirely.
      this.reasoningTailTimer = window.setTimeout(() => {
        tail.textContent = '';
        this.reasoningTailTimer = null;
      }, REASONING_TAIL_TIMEOUT);
    }
    this.pinChatToBottom();
  }

  /** Recomputes the pinned state from the scroll position and shows or hides the jump-down arrow. */
  private updateChatPinned(): void {
    const list = this.chatMessages;
    this.chatPinned = list.scrollHeight - list.scrollTop - list.clientHeight <= CHAT_PIN_THRESHOLD;
    this.chatJumpDown.hidden = this.chatPinned;
  }

  /** Scrolls the latest message into view, but only while the view sits at the bottom. */
  private pinChatToBottom(): void {
    if (this.chatPinned) {
      this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
  }

  private setChatBusy(busy: boolean): void {
    this.chatBusy = busy;
    this.chatStop.hidden = !busy;
    if (!busy) {
      this.chatInput.focus();
    }
  }

  /** Shrinks the chat input back to one line and grows it with the written lines. */
  private fitChatInput(): void {
    this.chatInput.style.height = 'auto';
    this.chatInput.style.height = `${this.chatInput.scrollHeight}px`;
  }

  private newChat(): void {
    const chat: Chat = {
      id: this.nextChatId,
      fileId: crypto.randomUUID(),
      title: `Chat ${this.nextChatId}`,
      createdAt: new Date().toISOString(),
      entries: [],
    };
    this.nextChatId += 1;
    this.chats.push(chat);
    this.activateChat(chat.id);
  }

  private closeChat(id: number): void {
    const index = this.chats.findIndex((chat) => chat.id === id);
    if (index < 0) {
      return;
    }
    const [chat] = this.chats.splice(index, 1);
    // The closed tab drops its session file, so a restart does not resurrect it.
    if (chat && !chat.isMcpHostLog) {
      this.chatSessions.deleteSession(chat.fileId);
    }
    if (this.activeChatId === id) {
      // The chat column keeps a chat: a neighbor takes over, or a fresh chat opens when none stays.
      const neighbor = this.chats[Math.min(index, this.chats.length - 1)];
      if (neighbor) {
        this.activateChat(neighbor.id);
      } else {
        this.newChat();
      }
      return;
    }
    this.renderTabs();
  }

  private activateChat(id: number): void {
    this.activeChatId = id;
    // A freshly opened tab starts at its latest message.
    this.chatPinned = true;
    const chat = this.chats.find((candidate) => candidate.id === id);
    if (chat) {
      chat.unread = false;
    }
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

  /** Opens or closes the settings view of the center workspace. The chat column stays beside it. */
  private toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    this.appSettings.classList.toggle('active', this.settingsOpen);
    if (this.settingsOpen) {
      getWorkarea().register('settings', {
        label: 'Settings',
        content: this.paneSettings,
        onClose: () => {
          this.toggleSettings();
        },
      });
      return;
    }
    getWorkarea().unregister('settings');
  }

  /** Activates the tab that holds the approval cards of one request source: the host log for host
   * sessions, the chat of the running agent turn for the chat agent. */
  private openPermissionTab(source: string | null): void {
    if (source !== CHAT_AGENT_SOURCE) {
      const host = this.mcpHostTab();
      if (host) {
        this.activateChat(host.id);
      }
      return;
    }
    const target = this.chats.find((chat) => chat.id === this.agentTurnChatId) ?? this.activeChat();
    if (target) {
      this.activateChat(target.id);
    }
  }

  private activeChat(): Chat | null {
    const id = this.activeChatId;
    // The host tab holds the id 0, so only a non-number id means no chat is active.
    if (typeof id !== 'number') {
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
    // The settings gear carries the badge while chat agent requests wait, because they answer in every chat tab.
    this.appSettings.classList.toggle('permissions', pendingSources.has(CHAT_AGENT_SOURCE));
    // The active tab scrolls into view, so a full strip keeps it reachable.
    this.chatTabs.querySelector<HTMLElement>('.tab-group.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The thinking select of one chat: Default follows the workspace setting, a level pins the chat. */
  private buildThinkingSelect(chat: Chat): HTMLSelectElement {
    const select = document.createElement('select');
    select.title = 'The reasoning effort of this chat. Default follows the workspace setting.';
    const levels: readonly (readonly [string, string])[] = [
      ['', 'Default'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ];
    for (const [value, label] of levels) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = chat.thinkingLevel ?? '';
    select.addEventListener('change', () => {
      const value = select.value;
      if (value === 'low' || value === 'medium' || value === 'high') {
        chat.thinkingLevel = value;
      } else {
        delete chat.thinkingLevel;
      }
      this.persistChat(chat);
    });
    return select;
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
      this.chatStatus.append(providerLabel, modelLabel, this.buildThinkingSelect(chat), usage);
      return;
    }
    if (this.registry.accounts.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'chat-status-label';
      empty.textContent = 'No provider';
      this.chatStatus.append(empty, this.buildThinkingSelect(chat), usage);
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
        chat.pendingModel && account.models.some((candidate) => candidate.id === chat.pendingModel) ?
          chat.pendingModel :
          this.effectiveDefaultModel(account);
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
    this.chatStatus.append(providerSelect, modelSelect, this.buildThinkingSelect(chat), usage);
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
    const label = document.createElement('span');
    label.textContent = 'Reasoning';
    // The collapsed tail carries the latest reasoning words while they stream, and clears when they stop.
    const tail = document.createElement('span');
    tail.className = 'reasoning-tail';
    summary.append(label, tail);
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    disclosure.append(summary, body);
    return { disclosure, body };
  }

  /** Builds one message item of a single entry: the bubble, the tool cards, or the reasoning disclosure.
   * The user, assistant, and error bubbles carry the action zone at their bottom right.
   * Returns null for one error entry the empty slot before it already rendered as its bubble body. */
  private buildMessageItem(
    chat: Chat,
    slot: EntrySlot,
    openReasoning: ReadonlySet<string>,
    isStreaming = false,
  ): HTMLLIElement | null {
    const { index, entry } = slot;
    if (this.editing?.chatId === chat.id && this.editing.index === index) {
      return this.buildMessageEditor(this.editing);
    }
    const item = document.createElement('li');
    item.dataset.entryIndex = String(index);
    if (entry.role === 'tool' || (entry.toolName && entry.role !== 'user')) {
      item.append(this.buildToolReplyCard(entry));
      return item;
    }
    if (entry.role === 'assistant' && entry.reasoning) {
      // The disclosure mounts with the first reasoning piece, never before it.
      item.className = 'message assistant';
      const { disclosure, body } = this.buildReasoningDisclosure(index, openReasoning);
      body.textContent = entry.reasoning;
      const text = document.createElement('span');
      text.className = 'message-text';
      text.textContent = entry.content;
      item.append(disclosure, text);
      const actions = this.buildMessageActions(chat, slot);
      if (actions) {
        item.append(actions);
      }
      return item;
    }
    if (entry.role === 'assistant' && !entry.content && !isStreaming && chat.entries[index + 1]?.role === 'error') {
      // The turn died before its first piece: one error bubble, the icon and a short label as its
      // title, the provider message as its content.
      const failure = chat.entries[index + 1];
      item.className = 'message error-bubble';
      const head = document.createElement('div');
      head.className = 'error-bubble-head';
      head.append(this.buildIconSvg(ICON_ERROR));
      const title = document.createElement('span');
      title.textContent = errorLabelOf(failure?.content ?? '');
      head.append(title);
      const body = document.createElement('div');
      body.className = 'error-bubble-body';
      body.textContent = failure?.content ?? '';
      item.append(head, body);
      return item;
    }
    if (
      entry.role === 'error' &&
      !entry.toolName &&
      chat.entries[index - 1]?.role === 'assistant' &&
      !chat.entries[index - 1]?.content &&
      !chat.entries[index - 1]?.reasoning &&
      !chat.entries[index - 1]?.toolCalls
    ) {
      // The empty slot before this error rendered the pair as one bubble.
      return null;
    }
    if (entry.role === 'assistant' && !entry.content && isStreaming) {
      // The slot holds nothing yet: the pulsing accent icon of the open connection.
      item.className = 'message stream-status connecting';
      item.append(this.buildIconSvg(ICON_CONNECTING));
      const label = document.createElement('span');
      label.textContent = 'Connecting…';
      item.append(label);
      return item;
    }
    item.className = `message ${entry.role}${entry.queued ? ' queued' : ''}`;
    item.textContent = entry.content;
    if (entry.queued) {
      const marker = document.createElement('span');
      marker.className = 'queued-marker';
      marker.textContent = '(queued)';
      item.append(marker);
    }
    if (entry.images && entry.images.length > 0) {
      item.append(this.buildImageStrip(entry.images));
    }
    const actions = this.buildMessageActions(chat, slot);
    if (actions) {
      item.append(actions);
    }
    return item;
  }

  /** Builds the action zone of one message: the icon row at the bottom right of the bubble.
   * A user message offers retry, copy, edit, and fork; an assistant reply offers copy. The retry
   * shows only on the user message whose turn ended in an error. The host log and a running turn
   * carry no zone. */
  private buildMessageActions(chat: Chat, slot: EntrySlot): HTMLElement | null {
    const { index, entry } = slot;
    if (chat.isMcpHostLog || this.chatBusy) {
      return null;
    }
    const zone = document.createElement('div');
    zone.className = 'message-actions';
    if (entry.role === 'user' && !entry.queued) {
      if (this.messageTurnFailed(chat, index)) {
        zone.append(
          this.buildMessageAction('Retry the failed message', ICON_RETRY, () => {
            void this.retryChatFrom(chat, index);
          }),
        );
      }
      zone.append(
        this.buildMessageAction('Copy the message text', ICON_COPY, () => {
          this.copyEntryText(entry.content);
        }),
        this.buildMessageAction('Edit and resend from here', ICON_EDIT, () => {
          this.editing = { chatId: chat.id, index, text: entry.content };
          this.renderMessages();
        }),
        this.buildMessageAction('Fork into a new tab from here', ICON_FORK, () => {
          this.forkChatAt(chat, index);
        }),
      );
      return zone;
    }
    if (entry.role === 'assistant') {
      zone.append(
        this.buildMessageAction('Copy the message text', ICON_COPY, () => {
          this.copyEntryText(entry.content);
        }),
      );
      return zone;
    }
    return null;
  }

  /** True when the turn of one user message ended in an error entry: no later sent message owns
   * the conversation between them. */
  private messageTurnFailed(chat: Chat, index: number): boolean {
    for (let cursor = index + 1; cursor < chat.entries.length; cursor += 1) {
      const entry = chat.entries[cursor];
      if (!entry) {
        continue;
      }
      if (entry.role === 'user' && !entry.queued) {
        return false;
      }
      if (entry.role === 'error' && !entry.toolName) {
        return true;
      }
    }
    return false;
  }

  /** Builds one stroke icon svg for the message UI, drawn on a 16 by 16 grid. */
  private buildIconSvg(iconPath: string): SVGSVGElement {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke.setAttribute('d', iconPath);
    icon.append(stroke);
    return icon;
  }

  /** Builds one icon button of the message action zone. */
  private buildMessageAction(title: string, iconPath: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(this.buildIconSvg(iconPath));
    button.addEventListener('click', () => {
      onClick();
    });
    return button;
  }

  /** Builds the open message editor: the pre-filled text area with the send and cancel actions.
   * An entry index replaces that message; a fork draft appends as a new message. */
  private buildMessageEditor(editing: { readonly text: string }): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'message-edit';
    const editor = document.createElement('textarea');
    editor.className = 'message-editor';
    editor.value = editing.text;
    const actions = document.createElement('div');
    actions.className = 'message-edit-actions';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'primary';
    send.textContent = 'Send';
    send.addEventListener('click', () => {
      void this.saveEditing();
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      this.editing = null;
      this.renderMessages();
    });
    actions.append(send, cancel);
    item.append(editor, actions);
    editor.addEventListener('input', () => {
      this.fitMessageEditor(editor);
    });
    // Enter sends; Shift+Enter and Ctrl+Enter break the line, like the chat input.
    editor.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.shiftKey || event.isComposing) {
        return;
      }
      event.preventDefault();
      void this.saveEditing();
    });
    // The editor still sits detached here, so the fit and the focus wait one frame for the list to mount it.
    requestAnimationFrame(() => {
      this.fitMessageEditor(editor);
      editor.focus();
    });
    // The caret starts at the end, so typing appends to the draft.
    editor.selectionStart = editing.text.length;
    editor.selectionEnd = editing.text.length;
    return item;
  }

  /** Grows the editor text area with its written lines. */
  private fitMessageEditor(editor: HTMLTextAreaElement): void {
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
  }

  /** The text body of one tool reply: a pre when the content carries new lines, so its formatting
   * survives the page layout, a span for a single line. */
  private buildToolText(content: string): HTMLElement {
    const body = document.createElement(content.includes('\n') ? 'pre' : 'span');
    body.className = 'tool-reply-text';
    body.textContent = content;
    return body;
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
        replySection.append(this.buildToolText(reply.content));
      }
      if (reply.images && reply.images.length > 0) {
        replySection.append(this.buildImageStrip(reply.images));
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
      card.append(this.buildToolText(entry.content));
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
    // The open state of the system prompt disclosure survives the rebuild the same way.
    const promptDisclosure = this.chatMessages.querySelector(':scope > li.system-prompt-item > details.system-prompt');
    const promptOpen = promptDisclosure instanceof HTMLDetailsElement ? promptDisclosure.open : false;
    this.chatMessages.replaceChildren();
    const chat = this.activeChat();
    if (!chat) {
      return;
    }
    this.appendSystemPromptItem(chat, promptOpen);
    // The streaming entry of a busy chat renders as the connecting status until its first piece lands.
    let streamingIndex = -1;
    if (this.chatBusy) {
      for (let index = chat.entries.length - 1; index >= 0; index -= 1) {
        const candidate = chat.entries[index];
        if (candidate && candidate.role === 'assistant') {
          streamingIndex = index;
          break;
        }
      }
    }
    for (const group of this.groupChatEntries(chat)) {
      if (group.kind === 'single') {
        const item = this.buildMessageItem(chat, group.slot, openReasoning, group.slot.index === streamingIndex);
        if (item) {
          this.chatMessages.append(item);
        }
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
    // The fork draft carries no entry yet, so its editor renders after the copied history.
    if (this.editing?.chatId === chat.id && this.editing.index === undefined) {
      this.chatMessages.append(this.buildMessageEditor(this.editing));
    }
    this.pinChatToBottom();
  }

  /** Renders the system prompt element first in the message list: the source menu before the first
   * sent message, the collapsed bound prompt after it. The none source and the host tab render nothing.
   * A chat that predates the prompt, or carries messages without one, renders nothing: its window passed. */
  private appendSystemPromptItem(chat: Chat, promptOpen: boolean): void {
    if (chat.isMcpHostLog || this.promptSources.length === 0) {
      return;
    }
    const bound = chat.boundSystemPrompt;
    if (bound) {
      if (bound.sourceId === NONE_SYSTEM_PROMPT_SETUP_ID || bound.text.length === 0) {
        return;
      }
      const item = document.createElement('li');
      item.className = 'system-prompt-item';
      const disclosure = document.createElement('details');
      disclosure.className = 'system-prompt';
      disclosure.open = promptOpen;
      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'system-prompt-title';
      label.textContent = bound.title;
      summary.append(label);
      const body = document.createElement('div');
      body.className = 'system-prompt-body';
      body.textContent = bound.text;
      disclosure.append(summary, body);
      item.append(disclosure);
      this.chatMessages.append(item);
      return;
    }
    if (this.chatHasConversation(chat)) {
      return;
    }
    const selected = this.selectedSystemPromptId(chat);
    const item = document.createElement('li');
    // The menu variant carries its own emphasis: centered and accented before the first send.
    item.className = 'system-prompt-item system-prompt-menu';
    const label = document.createElement('span');
    label.className = 'system-prompt-menu-label';
    label.textContent = 'System prompt';
    const select = document.createElement('select');
    select.className = 'system-prompt-select';
    select.title = 'The system prompt of the first message. The chat keeps it after the send.';
    for (const source of this.promptSources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label;
      select.append(option);
    }
    select.value = this.promptSources.some((source) => source.id === selected) ?
      selected :
      (this.promptSources[0]?.id ?? '');
    select.addEventListener('change', () => {
      chat.pendingSystemPromptId = select.value;
    });
    item.append(label, select);
    this.chatMessages.append(item);
  }

  /** The source id the chat menu holds: the pending selection, or the default of the workspace. */
  private selectedSystemPromptId(chat: Chat): string {
    if (chat.pendingSystemPromptId) {
      return chat.pendingSystemPromptId;
    }
    return defaultSystemPromptSetup(this.promptSources)?.id ?? NONE_SYSTEM_PROMPT_SETUP_ID;
  }

  /** The source the chat menu holds: the pending selection, or the default. Null reads the none source. */
  private selectedSystemPromptSetup(chat: Chat): SystemPromptSetup | null {
    const wanted = this.selectedSystemPromptId(chat);
    if (wanted === NONE_SYSTEM_PROMPT_SETUP_ID) {
      return null;
    }
    return this.promptSources.find((source) => source.id === wanted) ?? defaultSystemPromptSetup(this.promptSources);
  }
}
