/**
 * The main app screen: a tab bar with a fixed settings tab first, then the chat tabs.
 * The settings pane lives in `settings.ts` and mounts on the gear of this screen.
 * A chat pane sends its conversation through the configured provider and shows the reply.
 */

import { OpenAiInferenceProvider } from '../providers/openai.js';
import type { ChatImage, ChatMessage, CompletionDelta, ToolCall } from '../providers/provider.js';
import type { StorageSetup, SystemPromptSetup } from './plugins.js';
import { closeWindow, minimizeWindow, toggleDevToolsWindow, toggleMaximizeWindow } from './window-ops.js';
import { chatAgentSource, chatIdOfAgentSource, isChatAgentSource } from '../shared/permissions.js';
import { AppRail } from './rail.js';
import { installColumnResizers } from './chat-resizer.js';
import { getWorkarea } from './workarea.js';
import type { ProviderAccount, WorkspaceSettings } from '../shared/workspace.js';
import { presetOfAccount } from '../shared/provider-presets/index.js';
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
import { type ChatSessionStore, type ChatEntry, type StoredChatSession } from './chat-sessions.js';
import { JsonViewerElement } from './json-viewer-element.js';
import type { McpClientSurface } from './mcp-client-adapter.js';
import type { McpConnectionInfo, McpHostHandle, McpSessionSink } from '../shared/window-tools.js';
import type { NotificationHub } from './notification-hub.js';
import type { PermissionGate } from './permission-gate.js';
import { PatchStore, type PatchNotice } from './patch-store.js';
import { TaskStore } from './task-store.js';
import type { TaskToolDeps } from './task-tools.js';
import { openTaskBoardView } from './views/task-board/view.js';
import { openEditorView } from './editor-view.js';
import type { TaskRecord } from '../shared/tasks.js';
import { openPatchReviewView } from './patch-review.js';
import { PermissionRequestElement, type PermissionResolveDetail } from './permission-request-element.js';
import { requireElement } from './dom.js';
import { ChatRenderer, type Chat, type ChatEditState } from './chat-render.js';
import type { WorkspaceSettingsStore } from '../storage/settings-store.js';
import type { StorageShareRegistry } from './storage-shares.js';
import type { PluginFolderController } from './plugin-folders.js';
import { defaultSystemPromptSetup, NONE_SYSTEM_PROMPT_SETUP_ID } from './system-prompts.js';
import { effectiveDefaultAccount, effectiveDefaultModel, modelDisplayName, modelVision, SettingsView } from './settings.js';

/** The longest edge of a pasted or dropped image, in pixels. Bigger pictures scale down. */
const MAX_IMAGE_EDGE = 1280;

/** How many images one chat message may carry. */
const MAX_ATTACHMENTS = 4;

/** How far from the bottom, in pixels, the chat still counts as pinned to the latest message. */
const CHAT_PIN_THRESHOLD = 8;

/** How long the collapsed reasoning tail stays after the last reasoning delta, in milliseconds. */
const REASONING_TAIL_TIMEOUT = 1200;


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

/** Reads the image files out of one clipboard or drag file list. */
function imageFilesOf(files: FileList | null): readonly File[] {
  if (!files) {
    return [];
  }
  return Array.from(files).filter((file) => file.type.startsWith('image/'));
}

/** Formats one token count for the status bar: plain below 1000, one decimal in k above. */
function formatTokenCount(count: number | undefined): string {
  // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real count, only absence shows the dash
  if (count === undefined) {
    return '–';
  }
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}



/** Drives the main app screen. The chat model and the message list live in `chat-render.ts`. */
export class MainApp implements McpSessionSink {
  private readonly settings: WorkspaceSettings;
  private readonly permissionGate: PermissionGate | null;
  private readonly mcpClients: McpClientSurface;
  private readonly notificationHub: NotificationHub;
  private readonly workspacePath: string;
  private readonly storageShares: StorageShareRegistry;
  private readonly chatSessions: ChatSessionStore;
  private readonly promptSources: readonly SystemPromptSetup[];
  /** The settings pane of the center workspace. It owns the settings state of the workspace. */
  private readonly settingsView: SettingsView;
  private readonly chats: Chat[] = [];
  private activeChatId: number | null = null;
  private nextChatId = 1;
  /** True while the settings view fills the center workspace. The chat column stays beside it. */
  private settingsOpen = false;
  /** The left rail: the approvals feed and the files tree. */
  private rail: AppRail | null = null;
  private patchStore: PatchStore | null = null;
  /** The dispatchable task records of the workspace. */
  private taskStore: TaskStore | null = null;
  /** The task ids a dispatch holds in flight, so the store listener and the tool call never double-run one. */
  private readonly taskDispatching = new Set<string>();
  /** The nudge counts per task id: one nudge per running stretch, so a silent agent hears once. */
  private readonly taskNudges = new Map<string, number>();
  /** The abort controllers of the running agent turns, keyed by chat id, in start order. Chats
   * run their turns in parallel; one chat queues its own sends while its turn runs. */
  private readonly runningTurns = new Map<number, AbortController>();
  /** The images that ride along with the next message, from paste or drop. */
  private pendingImages: ChatImage[] = [];
  /** True while the chat view sits at the latest message, so new content keeps it in view. */
  private chatPinned = true;
  /** The pending clear of the collapsed reasoning tail, armed on every reasoning delta. */
  private reasoningTailTimer: number | null = null;
  /** The one open message editor: the chat it belongs to, the entry index it replaces, and its draft.
   * A missing index marks the draft of a fork, which appends as a new message at the end. */
  private editing: ChatEditState | null = null;
  /** The message list of the chat column. */
  private readonly messages: ChatRenderer;

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
  private readonly permissionRequests = requireElement<HTMLElement>('#permission-requests');

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
    this.permissionGate = permissionGate;
    this.mcpClients = mcpClients;
    this.notificationHub = notificationHub;
    this.workspacePath = workspacePath;
    this.storageShares = storageShares;
    this.chatSessions = chatSessions;
    this.promptSources = promptSources;
    this.settingsView = new SettingsView(
      store,
      permissionGate,
      mcpClients,
      storageShares,
      storageSetups,
      storageLabel,
      pluginFolders,
      {
        onRegistryChange: () => {
          this.renderChatStatus();
        },
        listAgentTools: () => availableAgentTools(this.agentToolDeps()),
      },
    );
    this.messages = new ChatRenderer(requireElement<HTMLOListElement>('#chat-messages'), {
      activeChat: () => this.activeChat(),
      isTurnRunning: (chatId) => this.isTurnRunning(chatId),
      editing: () => this.editing,
      setEditing: (editing) => {
        this.editing = editing;
      },
      promptSources: this.promptSources,
      selectedSystemPromptId: (chat) => this.selectedSystemPromptId(chat),
      chatHasConversation: (chat) => this.chatHasConversation(chat),
      pinChatToBottom: () => this.pinChatToBottom(),
      sendQueuedNow: (chat, index) => this.sendQueuedNow(chat, index),
      retryChatFrom: (chat, index) => this.retryChatFrom(chat, index),
      forkChatAt: (chat, index) => this.forkChatAt(chat, index),
      copyEntryText: (text) => this.copyEntryText(text),
      saveEditing: () => this.saveEditing(),
    });
    this.notificationHub.setChatNotifier((text) => {
      this.pushChatNotification(text);
    });
  }

  /**
   * Opens the settings pane, restores the stored chat sessions, and wires the events.
   *
   * @param mcpHost The running MCP host handle, or null when the host stays off.
   * @throws Error when the document misses a required element.
   */
  async start(mcpHost: McpHostHandle | null): Promise<void> {
    PermissionRequestElement.define();
    JsonViewerElement.define();
    this.permissionGate?.subscribe(() => {
      this.renderPermissionRequests();
      this.renderTabs();
      this.settingsView.renderAgentTools();
    });
    requireElement<HTMLElement>('#workspace-name').textContent = this.settings.name;
    await this.settingsView.initialize(mcpHost);
    // The gate loads its rules lazily on the first check. The rule-reading UI renders before any
    // check runs, so it must await the load or it reads an empty list and shows every tool on ask.
    await this.permissionGate?.ready();
    this.patchStore = new PatchStore();
    await this.patchStore.load();
    // Denials and returns leave for the agent of their chat at once. A running turn reads the
    // entry at its next loop step, and an idle chat starts a turn to process it.
    this.patchStore.onNotice((notice) => {
      void this.deliverPatchNotice(notice);
    });
    this.taskStore = new TaskStore();
    await this.taskStore.load();
    // Every record change pumps the queue: a ready queued task opens its session or enters an
    // idle bound one, and the tabs redraw with their task badges.
    this.taskStore.subscribe(() => {
      this.renderTabs();
      void this.pumpQueuedTasks();
    });
    // A settle tells the origin chat when it did not cause it: the background-notification parity.
    this.taskStore.onSettle((task) => {
      void this.deliverTaskSettle(task);
    });
    this.rail = new AppRail({
      gate: this.permissionGate,
      workspacePath: this.workspacePath,
      openTab: (source) => {
        this.openPermissionTab(source);
      },
      patchStore: this.patchStore,
      openPatch: (id, separateTab) => {
        void openPatchReviewView(this.patchStore!, id, separateTab);
      },
      taskStore: this.taskStore,
      openTaskBoard: () => {
        this.openTaskBoard();
      },
      openFile: (path, separateTab) => {
        void openEditorView(
          path,
          separateTab,
          this.taskStore ? { store: this.taskStore, openBoard: (id) => this.openTaskBoard(id) } : null,
        );
      },
    });
    this.rail.start();
    await this.settingsView.start();
    requireElement<HTMLButtonElement>('#app-close').addEventListener('click', () => {
      void closeWindow();
    });
    requireElement<HTMLButtonElement>('#app-minimize').addEventListener('click', () => {
      void minimizeWindow();
    });
    requireElement<HTMLButtonElement>('#app-maximize').addEventListener('click', () => {
      void toggleMaximizeWindow();
    });
    requireElement<HTMLButtonElement>('#app-devtools').addEventListener('click', () => {
      void toggleDevToolsWindow();
    });
    this.appSettings.addEventListener('click', () => {
      this.toggleSettings();
    });
    // The application menu reaches the same toggle, so the framed window without the top bar
    // holds the same option as the borderless one.
    readBridge()?.workspace.onWorkspaceEvent('workarea.settings', () => {
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
      const active = this.activeChat();
      if (active) {
        this.runningTurns.get(active.id)?.abort();
      }
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
    await this.relinkTaskSessions();
  }

  /** Re-links the runtime chat ids of the bound task records after a restore: the persisted
   * session files keep their binding, the numeric chat ids start fresh. A live record whose
   * session tab never came back keeps its stale id and shows on the board for a re-dispatch. */
  private async relinkTaskSessions(): Promise<void> {
    const store = this.taskStore;
    if (!store) {
      return;
    }
    for (const task of store.list()) {
      if (!task.sessionFileId) {
        continue;
      }
      const chat = this.chatByFileId(task.sessionFileId);
      if (chat) {
        await store.relink(task.id, chat.id);
      }
    }
  }

  /** Finds the chat one session file id owns. */
  private chatByFileId(fileId: string): Chat | null {
    return this.chats.find((chat) => chat.fileId === fileId) ?? null;
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
      this.messages.render();
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
      this.messages.render();
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
      this.messages.render();
      return;
    }
    chat.unread = true;
    this.renderTabs();
  }

  /** Renders the pending permission requests of the active chat tab above the chat input.
   * The host tab shows every host session's requests, a plain chat tab shows the requests its own
   * chat agent turn made: parallel turns attribute their requests to the chat that sent them.
   * Requests of the other tabs stay behind them; the bar names them, so a waiting request is never invisible. */
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
    const requests = all.filter((request) => {
      if (isChatAgentSource(request.source) === hostTabActive) {
        return false;
      }
      if (hostTabActive) {
        return true;
      }
      // A chat tab holds the requests its own turn made. The bare source carries no owner, so it
      // shows in any chat tab rather than nowhere.
      const owner = chatIdOfAgentSource(request.source);
      return owner === null || owner === chat?.id;
    });
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
        'A permission request waits in another tab. Open the tab to answer it.';
      this.permissionRequests.append(notice);
    }
    this.permissionRequests.hidden = this.permissionRequests.childElementCount === 0;
  }

  /** The connection one chat runs on: its bound provider and model, or the status bar selection.
   * Null when the chat has no usable provider, or when its bound provider no longer exists. */
  private resolveChatConnection(chat: Chat): { account: ProviderAccount; model: string; vision: boolean } | null {
    const registry = this.settingsView.registry;
    if (chat.boundProviderId) {
      const account = registry.accounts.find((candidate) => candidate.id === chat.boundProviderId);
      if (!account || !chat.boundModel) {
        return null;
      }
      return { account, model: chat.boundModel, vision: modelVision(account, chat.boundModel) };
    }
    const account =
      registry.accounts.find((candidate) => candidate.id === chat.pendingProviderId) ??
      effectiveDefaultAccount(registry);
    if (!account) {
      return null;
    }
    const model =
      chat.pendingModel && account.models.some((candidate) => candidate.id === chat.pendingModel) ?
        chat.pendingModel :
        effectiveDefaultModel(registry, account);
    if (!model) {
      return null;
    }
    return { account, model, vision: modelVision(account, model) };
  }

  private async send(): Promise<void> {
    const chat = this.activeChat();
    const text = this.chatInput.value.trim();
    const images = this.pendingImages;
    if (!chat || (text.length === 0 && images.length === 0)) {
      return;
    }
    if (chat.isMcpHostLog) {
      // The host tab logs sessions. It holds no provider and no transcript, so it answers no send.
      chat.entries.push({ role: 'notice', content: 'The MCP Host tab only logs host sessions. Send from a chat tab.' });
      this.messages.render();
      return;
    }
    if (this.isTurnRunning(chat.id)) {
      // The agent of this chat runs: the message waits as a dimmed entry and delivers when the run ends.
      this.chatInput.value = '';
      this.fitChatInput();
      this.pendingImages = [];
      this.renderAttachments();
      chat.entries.push({ role: 'user', content: text, ...(images.length > 0 ? { images: [...images] } : {}), queued: true });
      this.messages.render();
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
      this.messages.render();
      return false;
    }
    chat.boundSystemPrompt = { sourceId: setup.id, title: setup.label, text: promptText };
    this.messages.render();
    return true;
  }

  /** Lands one remote send: the chat of the named session file takes the message, the active chat
   * when the sender named none. A running turn queues the message like a local send does. */
  remoteDeliver(fileId: string | null, text: string): void {
    const chat = (fileId ? this.chatByFileId(fileId) : null) ?? this.activeChat() ?? this.chats.at(-1) ?? null;
    if (!chat || chat.isMcpHostLog || text.trim().length === 0) {
      return;
    }
    if (this.isTurnRunning(chat.id)) {
      chat.entries.push({ role: 'user', content: text, queued: true });
      this.messages.render();
      this.renderTabs();
      return;
    }
    void this.deliver(chat, text.trim(), [], { keepInput: true });
  }

  /** Delivers one message: resolves the connection, binds the system prompt, pushes the entry, and runs the agent turn. */
  private async deliver(
    chat: Chat,
    text: string,
    images: readonly ChatImage[],
    options?: { keepInput?: boolean },
  ): Promise<void> {
    const connection = this.resolveChatConnection(chat);
    if (connection && images.length > 0 && !connection.vision) {
      // Nothing is consumed: the text stays typed and the chips stay pending, so the user can switch model or remove the images.
      chat.entries.push({
        role: 'notice',
        content: `The model "${connection.model}" reads text only. Turn on its Vision flag in the settings, or remove the images.`,
      });
      this.messages.render();
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
    if (!options?.keepInput) {
      this.chatInput.value = '';
      this.fitChatInput();
      this.pendingImages = [];
      this.renderAttachments();
    }
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
      this.messages.render();
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
    this.runningTurns.set(chat.id, abort);
    this.updateTurnControls(chat.id, true);
    this.messages.render();
    let stopped = false;
    try {
      await this.runAgentTurn(
        chat,
        provider,
        connection.model,
        connection.vision,
        this.settingsView.agentTurnLimit,
        chat.thinkingLevel ?? this.settingsView.agentThinkingDefault ?? undefined,
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
      if (this.runningTurns.get(chat.id) === abort) {
        this.runningTurns.delete(chat.id);
      }
      this.updateTurnControls(chat.id, false);
      this.messages.render();
      this.renderTabs();
      this.persistChat(chat);
    }
    // A stop leaves the queue in place: the user halted the agent, so nothing follows on its own.
    if (stopped) {
      return;
    }
    await this.drainQueued(chat);
    await this.afterTaskTurn(chat);
  }

  /** Restarts the failed turn of one user message: every entry after the message drops, and the
   * turn runs again, so the failed message sends again from that exact point. */
  private async retryChatFrom(chat: Chat, messageIndex: number): Promise<void> {
    if (this.isTurnRunning(chat.id)) {
      return;
    }
    chat.entries.splice(messageIndex + 1);
    this.chatPinned = true;
    this.messages.render();
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
    if (!chat || this.isTurnRunning(chat.id)) {
      this.messages.render();
      return;
    }
    const target = typeof editing.index === 'number' ? chat.entries[editing.index] : undefined;
    const images = editing.images ?? target?.images ?? [];
    if (text.length === 0 && images.length === 0) {
      this.messages.render();
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
    this.messages.render();
    await this.runChatTurn(chat);
  }

  /** Copies one message text to the clipboard. */
  private copyEntryText(text: string): void {
    navigator.clipboard.writeText(text).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the message text could not be copied: ${message}`);
    });
  }

  /** Delivers the first waiting message of a chat after a finished run: one still queued, or a
   * send-now entry the finished turn never answered. The entry moves to the end as it delivers. */
  private async drainQueued(chat: Chat): Promise<void> {
    const index = chat.entries.findIndex((entry) => entry.role === 'user' && entry.queued);
    const queued = index >= 0 ? chat.entries[index] : undefined;
    if (queued) {
      chat.entries.splice(index, 1);
      this.messages.render();
      await this.deliver(chat, queued.content, queued.images ?? []);
      return;
    }
    // A send-now entry un-queued into the running turn still needs its answer when that turn
    // ended its final text without another loop step. It carries queued false, not absent.
    for (let position = chat.entries.length - 1; position >= 0; position -= 1) {
      const entry = chat.entries[position];
      if (entry?.role === 'assistant') {
        return;
      }
      if (entry?.role === 'user' && typeof entry.queued === 'boolean' && !entry.queued) {
        chat.entries.splice(position, 1);
        this.messages.render();
        await this.deliver(chat, entry.content, entry.images ?? []);
        return;
      }
    }
  }

  /** Sends one queued message at once. While a turn runs, the entry un-queues into the next
   * request of that turn, so it goes out without waiting for the turn to end. Without a running
   * turn it delivers immediately. */
  private async sendQueuedNow(chat: Chat, index: number): Promise<void> {
    const entry = chat.entries[index];
    if (!entry || entry.role !== 'user' || !entry.queued) {
      return;
    }
    chat.entries.splice(index, 1);
    if (this.isTurnRunning(chat.id)) {
      chat.entries.push({
        role: 'user',
        content: entry.content,
        ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
        // False, not absent: the drain after the run answers it when the turn ends without it.
        queued: false,
      });
      this.messages.render();
      this.persistChat(chat);
      return;
    }
    this.messages.render();
    await this.deliver(chat, entry.content, entry.images ?? []);
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
      this.messages.render();
      return;
    }
    if (files.length > room) {
      this.activeChat()?.entries.push({
        role: 'notice',
        content: `One message carries at most ${MAX_ATTACHMENTS} images. The first ${room} ${room === 1 ? 'stays' : 'stay'}, the rest drop.`,
      });
      this.messages.render();
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

  /** The dependencies the agent tools build from. The rule reader feeds the tool rule layer. A
   * running turn passes its chat, so the permission requests attribute to that chat's tab. */
  private agentToolDeps(chat?: Chat): AgentToolDeps {
    const gate: AgentToolDeps['gate'] =
      this.permissionGate ?? {
        check: async () => {
          throw new Error('No permission gate is wired.');
        },
      };
    return {
      gate,
      mcpClients: this.mcpClients,
      workspacePath: this.workspacePath,
      storageShares: this.storageShares,
      toolRules: () => this.permissionGate?.listRules() ?? [],
      source: chat ? chatAgentSource(chat.id) : CHAT_AGENT_SOURCE,
      chatId: chat?.id ?? this.activeChatId ?? 0,
      sessionFileId: chat?.fileId ?? null,
      patchStore: this.patchStore ?? new PatchStore(),
      pathRules: () => this.settingsView.pathRules,
      ...(this.taskStore ? { tasks: this.taskToolDeps(gate, chat) } : {}),
    };
  }

  /** The deps of the tasks tool: the store, the session and naming callbacks of this app, and the
   * permission surface the dispatch action asks through. */
  private taskToolDeps(gate: AgentToolDeps['gate'], chat?: Chat): TaskToolDeps {
    const chatId = chat?.id ?? this.activeChatId ?? 0;
    return {
      store: this.taskStore!,
      dispatch: (id, mode, sessionFileId) => this.dispatchTask(id, mode, sessionFileId),
      send: (id, message) => this.sendTask(id, message),
      setTaskName: async (title, description, amend) => {
        const store = this.patchStore;
        if (!store) {
          throw new Error('No patch store is wired.');
        }
        if (!amend && !title) {
          throw new Error('A new task needs a title. Pass amend true to change the open task.');
        }
        if (amend && !store.openTask(chatId)) {
          throw new Error('No open task to amend. Start one without amend.');
        }
        const task = await store.setTask(chatId, title, description, amend);
        return amend ? `The task now reads "${task.title}".` : `The task "${task.title}" started.`;
      },
      chatId,
      check: gate,
      dispatchAllowed: () => agentToolRule('tasks', this.permissionGate?.listRules() ?? [])?.effect === 'allow',
      source: chat ? chatAgentSource(chat.id) : CHAT_AGENT_SOURCE,
    };
  }

  /** Delivers one patch notice into its chat: the entry lands for the next loop step, and an idle
   * chat starts a turn to process it. The host log tab holds no agent, so its notices drop. */
  private async deliverPatchNotice(notice: PatchNotice): Promise<void> {
    const chat = this.chats.find((candidate) => candidate.id === notice.chatId);
    if (!chat || chat.isMcpHostLog) {
      return;
    }
    chat.entries.push({ role: 'user', content: notice.text });
    this.messages.render();
    this.persistChat(chat);
    if (!this.isTurnRunning(chat.id)) {
      await this.runChatTurn(chat);
    }
  }

  /** Delivers one task message into a chat: the entry lands for the next loop step, and an idle
   * chat starts a turn to process it. Task briefs, nudges, settles, and sends all ride this. */
  private async deliverTaskNotice(chat: Chat, text: string): Promise<void> {
    if (chat.isMcpHostLog) {
      return;
    }
    chat.entries.push({ role: 'user', content: text });
    this.messages.render();
    this.persistChat(chat);
    if (!this.isTurnRunning(chat.id)) {
      await this.runChatTurn(chat);
    }
  }

  /** Builds the brief entry one session reads when it takes a task. */
  private taskBrief(task: TaskRecord): string {
    const rows = [`[task ${task.id}] ${task.title}`];
    if (task.description) {
      rows.push(task.description);
    }
    if (task.goal) {
      rows.push(`Goal: ${task.goal}`);
    }
    rows.push('Work only this task. Verify the goal before you finish, then call the tasks tool with action complete (id, result, evidence), or action fail (id, reason) when it does not hold.');
    return rows.join('\n');
  }

  /**
   * Dispatches one queued task onto its session. A new-session dispatch opens the chat tab; a
   * session dispatch hands the task to its bound chat when that chat sits idle. A busy chat and a
   * blocked task keep the record queued, and the pump takes them when their turn comes.
   *
   * @param id The record id.
   * @param mode How the dispatch binds the session.
   * @param sessionFileId The chat session file, on session mode.
   * @returns The outcome text the agent reads.
   */
  private async dispatchTask(id: string, mode: 'new-session' | 'session', sessionFileId: string | null): Promise<string> {
    const store = this.taskStore;
    if (!store || this.taskDispatching.has(id)) {
      return 'The dispatch is already in flight.';
    }
    const task = store.get(id);
    if (!task) {
      return 'The task does not exist.';
    }
    if (task.status !== 'queued') {
      return `The task holds state ${task.status}.`;
    }
    if (!store.ready(task)) {
      return `The task waits for its blockedBy tasks: ${task.blockedBy.join(', ')}.`;
    }
    this.taskDispatching.add(id);
    try {
      if (mode === 'session') {
        const chat = sessionFileId ? this.chatByFileId(sessionFileId) : null;
        if (!chat) {
          return `The chat session ${sessionFileId ?? '(none)'} holds no open tab. The task stays queued.`;
        }
        if (this.isTurnRunning(chat.id)) {
          return 'The session runs a turn. The task stays queued and enters when it idles.';
        }
        await this.takeTaskOnChat(chat, task);
        return `The task entered the session "${chat.title}".`;
      }
      const chat: Chat = {
        id: this.nextChatId,
        fileId: crypto.randomUUID(),
        title: task.title,
        createdAt: new Date().toISOString(),
        entries: [],
        taskId: task.id,
      };
      this.nextChatId += 1;
      this.chats.push(chat);
      await this.takeTaskOnChat(chat, task);
      return 'A new chat session opened for the task.';
    } finally {
      this.taskDispatching.delete(id);
    }
  }

  /** Binds one chat to a task, pushes the brief, and runs the turn on an idle chat. */
  private async takeTaskOnChat(chat: Chat, task: TaskRecord): Promise<void> {
    const store = this.taskStore;
    if (!store) {
      return;
    }
    chat.taskId = task.id;
    await store.bindSession(task.id, chat.id, chat.fileId);
    // The session names its work after the record, so the patches of the run group under the task
    // title and the tab reads it.
    await this.patchStore?.setTask(chat.id, task.title, task.description, false);
    chat.entries.push({ role: 'user', content: this.taskBrief(task) });
    this.messages.render();
    this.persistChat(chat);
    this.renderTabs();
    if (!this.isTurnRunning(chat.id)) {
      await this.runChatTurn(chat);
    }
  }

  /** Opens sessions and hands idle chats their next ready queued task. Runs on every record change. */
  private async pumpQueuedTasks(): Promise<void> {
    const store = this.taskStore;
    if (!store) {
      return;
    }
    for (const task of store.list()) {
      if (task.status !== 'queued' || this.taskDispatching.has(task.id) || !store.ready(task)) {
        continue;
      }
      if (task.dispatchMode === 'new-session' && !task.sessionFileId) {
        await this.dispatchTask(task.id, 'new-session', null);
        continue;
      }
      if (task.dispatchMode === 'session' && task.sessionFileId) {
        const chat = this.chatByFileId(task.sessionFileId);
        if (chat && !this.isTurnRunning(chat.id)) {
          await this.dispatchTask(task.id, 'session', task.sessionFileId);
        }
      }
    }
  }

  /** Handles the task of one chat after its turn: one nudge on a silent running task, and the
   * queue pump when the task settled so the next one enters. */
  private async afterTaskTurn(chat: Chat): Promise<void> {
    const store = this.taskStore;
    if (!store || !chat.taskId) {
      return;
    }
    const task = store.get(chat.taskId);
    if (!task) {
      return;
    }
    if (task.status === 'running') {
      const nudged = this.taskNudges.get(task.id) ?? 0;
      if (nudged < 1) {
        this.taskNudges.set(task.id, nudged + 1);
        await this.deliverTaskNotice(
          chat,
          `[task ${task.id}] The turn ended without a completion. Call the tasks tool: action complete (id, result, evidence), or action fail (id, reason).`,
        );
      }
      return;
    }
    this.taskNudges.delete(task.id);
    await this.pumpQueuedTasks();
  }

  /** Tells the origin chat of one settle it did not cause, so a waiting parent learns the outcome. */
  private async deliverTaskSettle(task: TaskRecord): Promise<void> {
    this.taskNudges.delete(task.id);
    const origin = task.originChatId ? this.chats.find((chat) => chat.id === task.originChatId) ?? null : null;
    if (!origin || origin.isMcpHostLog || origin.id === task.sessionChatId) {
      return;
    }
    let head = `Task ${task.id} was cancelled${task.note ? `: ${task.note}` : '.'}`;
    if (task.status === 'review') {
      head = `The session completed task ${task.id}. The review waits.`;
    } else if (task.status === 'done') {
      head = `The user accepted task ${task.id}.`;
    } else if (task.status === 'failed') {
      head = `The session failed task ${task.id}${task.note ? `: ${task.note}` : '.'}`;
    }
    await this.deliverTaskNotice(origin, `[task settle] ${head}${task.result ? `\nResult: ${task.result}` : ''}`);
  }

  /** Finds the chat one task record is bound to in this app run. */
  private chatOfTask(task: TaskRecord): Chat | null {
    return task.sessionChatId ? this.chats.find((chat) => chat.id === task.sessionChatId) ?? null : null;
  }

  /** Opens the task board in the center workspace. A focus id opens that record in its edit form. */
  private openTaskBoard(focusId?: string): void {
    const store = this.taskStore;
    if (!store) {
      return;
    }
    void openTaskBoardView({
      store,
      dispatch: (id, mode, sessionFileId) => this.dispatchTask(id, mode, sessionFileId),
      openSession: (chatId) => {
        this.activateChat(chatId);
      },
      sessions: () =>
        this.chats
          .filter((chat) => !chat.isMcpHostLog)
          .map((chat) => ({ fileId: chat.fileId, title: chat.title })),
      returnTask: (id, comment) => {
        void this.returnTask(id, comment);
      },
    }, focusId ?? null);
  }

  /** Returns one review to its session: the record moves back to running and the comment of the
   * user rides to the session agent as a re-brief. */
  private async returnTask(id: string, comment: string | null): Promise<void> {
    const store = this.taskStore;
    const task = store?.get(id) ?? null;
    if (!store || !task) {
      return;
    }
    const chat = this.chatOfTask(task);
    const returned = await store.returnToSession(id);
    if (!returned || !chat) {
      return;
    }
    await this.deliverTaskNotice(
      chat,
      `[task ${id}] The user returned the task with a comment:${comment ? `\n${comment}` : ''}\nAddress the comment, then call the tasks tool with action complete again.`,
    );
  }

  /** Sends one message into the session of a task. A busy session queues the entry for its drain. */
  private async sendTask(id: string, message: string): Promise<string> {
    const store = this.taskStore;
    const task = store?.get(id) ?? null;
    if (!store || !task) {
      return 'The task does not exist.';
    }
    const chat = this.chatOfTask(task);
    if (!chat) {
      return 'The task holds no open session tab.';
    }
    if (this.isTurnRunning(chat.id)) {
      chat.entries.push({ role: 'user', content: `[task ${id}] ${message}`, queued: true });
      this.messages.render();
      this.persistChat(chat);
      return 'The session runs a turn. The message queued and delivers when it ends.';
    }
    await this.deliverTaskNotice(chat, `[task ${id}] ${message}`);
    return 'The message entered the session.';
  }

  /** The tools the agent may call this turn, the built-ins plus the native MCP tools, without the
   * disabled ones. The turn's chat scopes the permission requests. */
  private agentTools(chat: Chat): readonly AgentTool[] {
    return buildAgentTools(this.agentToolDeps(chat));
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
    while (typeof limit !== 'number' || turn < limit) {
      turn += 1;
      const tools = this.agentTools(chat);
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
      args = typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
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
      json = typeof parsed === 'object' && parsed ? parsed : undefined;
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
    this.messages.render();
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
        this.messages.render();
      },
    };
  }

  /**
   * Patches the streaming entry into the live list item instead of rebuilding the whole list,
   * so a click or an open disclosure never fights the stream renders.
   * A missing or replaced list item falls back to one full render.
   */
  private patchStreamingEntry(chat: Chat, slot: ChatEntry): void {
    if (chat.id !== this.activeChatId) {
      // A background turn streams unseen: the tab badges until the user opens it, and the patch
      // stays off the list, which renders another chat.
      if (!chat.unread) {
        chat.unread = true;
        this.renderTabs();
      }
      return;
    }
    const index = chat.entries.indexOf(slot);
    const entry = index >= 0 ? chat.entries[index] : undefined;
    const item = this.chatMessages.querySelector(`:scope > li[data-entry-index="${index}"]`);
    if (!entry || entry.role !== 'assistant' || !(item instanceof HTMLElement)) {
      this.messages.render();
      return;
    }
    const text = item.querySelector(':scope > .message-text');
    const body = item.querySelector(':scope > details.reasoning > .reasoning-body');
    if (!(text instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      this.messages.render();
      return;
    }
    this.messages.fillEntryText(text, entry);
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

  /** True while one chat runs an agent turn. */
  private isTurnRunning(chatId: number): boolean {
    return this.runningTurns.has(chatId);
  }

  /** Updates the composer controls for one turn state of one chat: the Stop button shows while
   * the active chat runs, and the input takes focus when the active chat goes idle. A background
   * chat never touches the controls of the tab the user reads. */
  private updateTurnControls(chatId: number, running: boolean): void {
    if (chatId !== this.activeChatId) {
      return;
    }
    this.chatStop.hidden = !running;
    if (!running) {
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
    // A live task bound to the closed chat settles cancelled, so the record never holds a dead session.
    if (chat?.taskId) {
      const task = this.taskStore?.get(chat.taskId);
      if (task && (task.status === 'running' || task.status === 'queued') && task.sessionFileId === chat.fileId) {
        void this.taskStore?.cancel(task.id, 'The session tab closed.');
      }
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
    // The Stop button serves the active chat's turn, so a tab switch moves it with the view.
    this.chatStop.hidden = !this.isTurnRunning(id);
    // The MCP host tab logs traffic. The host cannot push a message to the connected clients,
    // so the tab carries no message input and no status bar of a chat that cannot send.
    const sessionLog = Boolean(chat?.isMcpHostLog);
    this.chatForm.hidden = sessionLog;
    this.chatStatus.hidden = sessionLog;
    this.renderTabs();
    this.messages.render();
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
   * sessions, the chat the source scopes to for the chat agent, the active chat for the bare source. */
  private openPermissionTab(source: string | null): void {
    if (!isChatAgentSource(source)) {
      const host = this.mcpHostTab();
      if (host) {
        this.activateChat(host.id);
      }
      return;
    }
    const owner = chatIdOfAgentSource(source);
    const target = this.chats.find((chat) => chat.id === owner) ?? this.activeChat();
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
    // The host tab badges when any host session waits; the chat agent answers in the tab of the
    // turn that made the request, so only the chat each source scopes to badges.
    const hostWaits = [...pendingSources].some((source) => !isChatAgentSource(source));
    const waitingChatIds = new Set<number>();
    for (const source of pendingSources) {
      if (!isChatAgentSource(source)) {
        continue;
      }
      const owner = chatIdOfAgentSource(source) ?? this.activeChatId;
      if (typeof owner === 'number') {
        waitingChatIds.add(owner);
      }
    }
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
      if (chat.isMcpHostLog ? hostWaits : waitingChatIds.has(chat.id)) {
        classes.push('permissions');
      }
      group.className = classes.join(' ');
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      // The open task of the chat renames its tab, so the work reads by name.
      tab.textContent = (chat.isMcpHostLog ? null : this.patchStore?.openTaskTitle(chat.id)) ?? chat.title;
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
    const registry = this.settingsView.registry;
    const usage = document.createElement('span');
    usage.className = 'chat-status-usage';
    usage.title = 'Context tokens of the last request · output tokens of the whole chat';
    usage.textContent = `ctx ${formatTokenCount(chat.contextTokens)} · out ${formatTokenCount(chat.outputTokens)}`;
    if (chat.boundProviderId) {
      const account = registry.accounts.find((candidate) => candidate.id === chat.boundProviderId);
      const providerLabel = document.createElement('span');
      providerLabel.className = 'chat-status-label';
      providerLabel.textContent = account?.label ?? 'unknown provider';
      const modelLabel = document.createElement('span');
      modelLabel.className = 'chat-status-label';
      modelLabel.textContent =
        account && chat.boundModel ? modelDisplayName(account, chat.boundModel) : (chat.boundModel ?? '–');
      this.chatStatus.append(providerLabel, modelLabel, this.buildThinkingSelect(chat), usage);
      return;
    }
    if (registry.accounts.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'chat-status-label';
      empty.textContent = 'No provider';
      this.chatStatus.append(empty, this.buildThinkingSelect(chat), usage);
      return;
    }
    const selectedAccount =
      registry.accounts.find((candidate) => candidate.id === chat.pendingProviderId) ??
      effectiveDefaultAccount(registry);
    if (!selectedAccount) {
      return;
    }
    const providerSelect = document.createElement('select');
    providerSelect.title = 'The provider of the first message. The chat stays on it after the send.';
    for (const account of registry.accounts) {
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
        option.textContent = modelDisplayName(account, model.id);
        modelSelect.append(option);
      }
      const pending =
        chat.pendingModel && account.models.some((candidate) => candidate.id === chat.pendingModel) ?
          chat.pendingModel :
          effectiveDefaultModel(registry, account);
      if (pending) {
        modelSelect.value = pending;
      }
    };
    renderModelOptions(selectedAccount);
    providerSelect.addEventListener('change', () => {
      chat.pendingProviderId = providerSelect.value;
      delete chat.pendingModel;
      const next = registry.accounts.find((candidate) => candidate.id === providerSelect.value);
      if (next) {
        renderModelOptions(next);
      }
    });
    modelSelect.addEventListener('change', () => {
      chat.pendingModel = modelSelect.value;
    });
    this.chatStatus.append(providerSelect, modelSelect, this.buildThinkingSelect(chat), usage);
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
