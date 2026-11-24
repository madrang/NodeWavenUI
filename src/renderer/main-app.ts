/**
 * The main app screen: a tab bar with a fixed settings tab first, then the chat tabs.
 * The settings pane lives in `settings.ts` and mounts on the gear of this screen.
 * The screen renders the chats the engine of the worker core owns (`src/renderer/chat-client.ts`):
 * the turns, the tools, and the provider calls run there. This file keeps the tabs, the composer,
 * the message list, and the permission cards.
 */

import type { ChatImage, ThinkingLevel } from '../providers/provider.js';
import type { StorageSetup, SystemPromptSetup } from './plugins.js';
import { closeWindow, minimizeWindow, toggleDevToolsWindow, toggleMaximizeWindow } from './window-ops.js';
import { chatIdOfAgentSource, isChatAgentSource } from '../shared/permissions.js';
import { AppRail } from './rail.js';
import { installColumnResizers } from './chat-resizer.js';
import { getWorkarea } from './workarea.js';
import type { ProviderAccount, WorkspaceSettings } from '../shared/workspace.js';
import { effectiveDefaultAccount, effectiveDefaultModel } from '../shared/workspace.js';
import { readBridge } from '../shared/bridge.js';
import type { CoreAgentToolInfo, CoreChatPicks } from '../shared/core-api.js';
import { JsonViewerElement } from './json-viewer-element.js';
import type { McpClientSurface } from './mcp-client-adapter.js';
import type { McpConnectionInfo, McpHostHandle, McpSessionSink } from '../shared/window-tools.js';
import type { NotificationHub } from './notification-hub.js';
import type { PermissionGate } from './permission-gate.js';
import { PatchStore } from './patch-store.js';
import { TaskStore } from './task-store.js';
import { openTaskBoardView } from './views/task-board/view.js';
import { openEditorView } from './editor-view.js';
import { openPatchReviewView } from './patch-review.js';
import { PermissionRequestElement, type PermissionResolveDetail } from './permission-request-element.js';
import { requireElement } from './dom.js';
import { ChatRenderer, type Chat, type ChatEditState } from './chat-render.js';
import type { ChatEntry } from './chat-sessions.js';
import type { WorkspaceSettingsStore } from '../storage/settings-store.js';
import type { StorageShareRegistry } from '../storage/share-registry.js';
import type { PluginFolderController } from './plugin-folders.js';
import { NONE_SYSTEM_PROMPT_SETUP_ID, defaultSystemPromptSetup } from './system-prompts.js';
import { ChatClient, type ChatChange } from './chat-client.js';
import { modelDisplayName, SettingsView } from './settings.js';
import { log } from './logger.js';

/** The longest edge of a pasted or dropped image, in pixels. Bigger pictures scale down. */
const MAX_IMAGE_EDGE = 1280;

/** How many images one chat message may carry. */
const MAX_ATTACHMENTS = 4;

/** How far from the bottom, in pixels, the chat still counts as pinned to the latest message. */
const CHAT_PIN_THRESHOLD = 8;

/** How long the collapsed reasoning tail stays after the last reasoning delta, in milliseconds. */
const REASONING_TAIL_TIMEOUT = 1200;

/** The minimum gap between two streamed renders of one chat, in milliseconds. */
const STREAM_RENDER_INTERVAL = 80;


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
  private readonly promptSources: readonly SystemPromptSetup[];
  /** The settings pane of the center workspace. It owns the settings state of the workspace. */
  private readonly settingsView: SettingsView;
  /** The chats of the workspace, owned by the engine of the worker core. */
  private readonly chats: ChatClient;
  /** The one MCP host tab, which logs every host session. It belongs to this page alone: it never
   * persists and sits before every chat tab. Null before the first connection. */
  private hostTab: Chat | null = null;
  private activeChatId: number | null = null;
  /** The tools of the chat agent, for the settings matrix. The engine lists them. */
  private agentTools: readonly CoreAgentToolInfo[] = [];
  /** True while the settings view fills the center workspace. The chat column stays beside it. */
  private settingsOpen = false;
  /** The left rail: the approvals feed and the files tree. */
  private rail: AppRail | null = null;
  private patchStore: PatchStore | null = null;
  /** The dispatchable task records of the workspace. */
  private taskStore: TaskStore | null = null;
  /** The images that ride along with the next message, from paste or drop. */
  private pendingImages: ChatImage[] = [];
  /** True while the chat view sits at the latest message, so new content keeps it in view. */
  private chatPinned = true;
  /** The pending clear of the collapsed reasoning tail, armed on every reasoning delta. */
  private reasoningTailTimer: number | null = null;
  /** The time of the last streamed render of one chat, keyed by chat id. A missing time renders at once. */
  private readonly streamRenders = new Map<number, number>();
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
    promptSources: readonly SystemPromptSetup[],
    pluginFolders: PluginFolderController,
  ) {
    this.settings = settings;
    this.permissionGate = permissionGate;
    this.mcpClients = mcpClients;
    this.notificationHub = notificationHub;
    this.workspacePath = workspacePath;
    this.storageShares = storageShares;
    this.promptSources = promptSources;
    const bridge = readBridge();
    if (!bridge) {
      throw new Error('The main app screen needs the nodewavenui bridge of an app window.');
    }
    this.chats = new ChatClient(bridge, (chatId) => chatId === this.activeChatId);
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
        listAgentTools: () => this.agentTools,
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
    this.chats.subscribe((change) => {
      this.onChatChange(change);
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
    this.taskStore = new TaskStore();
    await this.taskStore.load();
    // The record changes redraw the tabs with their task badges. The queue pump runs in the engine.
    this.taskStore.subscribe(() => {
      this.renderTabs();
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
      openTaskBoard: (id) => {
        this.openTaskBoard(id ?? undefined);
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
      void this.newChat();
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
        this.fire('the stop of the turn', this.chats.stop(active.id));
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
    // The tool matrix lists the tools of the engine. The native tools follow the connections,
    // so the list reads again whenever they change.
    this.mcpClients.subscribe(() => {
      this.fire('the agent tool list', this.refreshAgentTools());
    });
    await this.refreshAgentTools();
    await this.restoreChats();
  }

  /** Reads the tool list of the chat engine from the core, and renders the tool matrix. */
  private async refreshAgentTools(): Promise<void> {
    this.agentTools = await this.chats.tools();
    this.settingsView.renderAgentTools();
  }

  /** Loads the chats the engine restored, in creation order, and activates the newest. A workspace
   * without a stored session opens one fresh chat. */
  private async restoreChats(): Promise<void> {
    await this.chats.load();
    const newest = this.chats.list().at(-1) ?? null;
    if (!newest) {
      await this.newChat();
      return;
    }
    this.activateChat(newest.id);
  }

  /** Renders one state change the core pushed: the tabs on every list change, the status bar on a
   * state change, and the message list when the active chat took an entry or finished a turn. */
  private onChatChange(change: ChatChange): void {
    if (change.kind === 'delta') {
      const chat = this.chats.get(change.chatId);
      if (chat) {
        this.renderStreamed(chat, change.entry);
      }
      return;
    }
    if (change.kind === 'unread') {
      this.renderTabs();
      return;
    }
    if (change.kind === 'entries') {
      // A new entry opens the throttle of the streamed renders, so its first piece shows at once.
      this.streamRenders.delete(change.chatId);
      if (change.chatId === this.activeChatId) {
        this.messages.render();
      }
      return;
    }
    this.renderTabs();
    if (change.kind === 'meta') {
      this.renderChatStatus();
      if (change.runningChanged) {
        this.updateTurnControls(change.chatId, this.chats.isRunning(change.chatId));
        this.messages.render();
      }
      return;
    }
    if (change.chatId === this.activeChatId) {
      this.messages.render();
    }
  }

  /** Lets one chat request of the core run on its own, and reports its failure in the log. */
  private fire(what: string, request: Promise<unknown>): void {
    void request.catch((error: unknown) => {
      log.main.warning(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
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
    return this.hostTab;
  }

  /** Creates the host tab and activates it, the first time a client connects. It sits before every chat tab. */
  private createMcpHostTab(): Chat {
    this.hostTab = {
      // The host tab holds the id 0, below every chat number, so it consumes no chat title.
      id: 0,
      fileId: crypto.randomUUID(),
      title: 'MCP Host',
      createdAt: new Date().toISOString(),
      entries: [],
      isMcpHostLog: true,
    };
    this.activateChat(0);
    return this.hostTab;
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
    const chat = this.activeChat() ?? this.chats.list().at(-1) ?? null;
    if (!chat) {
      return;
    }
    if (chat.isMcpHostLog) {
      // The host tab belongs to this page alone, so its entry lands here.
      chat.entries.push({ role: 'user', content: text });
      this.messages.render();
      return;
    }
    this.fire('the chat notification', this.chats.notify(chat.id, text));
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
    if (!this.isTurnRunning(chat.id)) {
      // The user acts on the latest message, so the send pins the view back to it.
      this.chatPinned = true;
    }
    // The engine queues the message itself while the turn of this chat runs, and answers false when
    // a notice entry explains a refusal: nothing is consumed then, so the composer keeps its draft.
    const accepted = await this.chats.send(chat, text, images, this.connectionPicks(chat));
    if (accepted) {
      this.chatInput.value = '';
      this.fitChatInput();
      this.pendingImages = [];
      this.renderAttachments();
    }
  }

  /** The connection picks of one first send: the provider, the model, and the system prompt the
   * status bar and the chat menu hold while the chat sent nothing. */
  private connectionPicks(chat: Chat): CoreChatPicks {
    return {
      ...(chat.pendingProviderId ? { providerId: chat.pendingProviderId } : {}),
      ...(chat.pendingModel ? { model: chat.pendingModel } : {}),
      systemPromptId: this.selectedSystemPromptId(chat),
    };
  }

  /** True when the chat already carries a sent message, so its system prompt window has passed. */
  private chatHasConversation(chat: Chat): boolean {
    return chat.entries.some((entry) => entry.role === 'user' || entry.role === 'assistant');
  }

  /** Restarts the failed turn of one user message in the core: every entry after the message drops,
   * and the turn runs again from that exact point. */
  private retryChatFrom(chat: Chat, messageIndex: number): void {
    if (this.isTurnRunning(chat.id)) {
      return;
    }
    this.chatPinned = true;
    this.fire(`the retry in chat ${chat.id}`, this.chats.retry(chat.id, messageIndex));
  }

  /** Copies the history before one user message into a new chat tab, then opens the message editor
   * there with the original text. The source chat keeps its whole conversation. */
  private forkChatAt(chat: Chat, index: number): void {
    const original = chat.entries[index];
    if (!original) {
      return;
    }
    const fork = this.chats.fork(chat.id, index).then((created) => {
      if (!created) {
        return;
      }
      this.editing = {
        chatId: created.id,
        text: original.content,
        ...(original.images && original.images.length > 0 ? { images: original.images } : {}),
      };
      this.activateChat(created.id);
    });
    this.fire(`the fork of chat ${chat.id}`, fork);
  }

  /** Sends the edited draft: the core replaces the edited message with it, or appends a fork draft,
   * and restarts the turn from there. */
  private async saveEditing(): Promise<void> {
    const editing = this.editing;
    const editor = this.chatMessages.querySelector('textarea.message-editor');
    if (!editing || !(editor instanceof HTMLTextAreaElement)) {
      return;
    }
    const text = editor.value.trim();
    const chat = this.chats.get(editing.chatId) ?? null;
    this.editing = null;
    if (!chat || this.isTurnRunning(chat.id)) {
      this.messages.render();
      return;
    }
    this.chatPinned = true;
    // The editor closes with this send. The core lands the entry, and the list renders its change.
    this.messages.render();
    this.fire(`the edited send in chat ${chat.id}`, this.chats.edit(editing, text, this.connectionPicks(chat)));
  }

  /** Copies one message text to the clipboard. */
  private copyEntryText(text: string): void {
    navigator.clipboard.writeText(text).catch((error: unknown) => {
      log.main.warning(`the message text could not be copied: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Sends one queued message at once. The core un-queues it into the next request of the running
   * turn, or delivers it when no turn runs. */
  private sendQueuedNow(chat: Chat, index: number): void {
    this.fire(`the send-now in chat ${chat.id}`, this.chats.sendNow(chat.id, index));
  }

  /** Adds image files from paste or drop to the pending attachments, downscaled and capped. */
  private async addImageFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const room = MAX_ATTACHMENTS - this.pendingImages.length;
    if (room <= 0) {
      this.attachNotice(`One message carries at most ${MAX_ATTACHMENTS} images.`);
      return;
    }
    if (files.length > room) {
      this.attachNotice(`One message carries at most ${MAX_ATTACHMENTS} images. The first ${room} ${room === 1 ? 'stays' : 'stay'}, the rest drop.`);
    }
    for (const file of files.slice(0, room)) {
      try {
        this.pendingImages.push(await this.readImageFile(file));
      } catch (error) {
        log.main.warning(`the image "${file.name}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.renderAttachments();
  }

  /** Lands one attachment notice in the transcript of the active chat. */
  private attachNotice(text: string): void {
    const chat = this.activeChat();
    if (chat?.isMcpHostLog) {
      chat.entries.push({ role: 'notice', content: text });
      this.messages.render();
      return;
    }
    if (chat) {
      this.fire('the attachment notice', this.chats.notice(chat.id, text));
    }
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

  /** Opens the task board in the center workspace. A focus id opens that record in its edit form. */
  private openTaskBoard(focusId?: string): void {
    const store = this.taskStore;
    if (!store) {
      return;
    }
    void openTaskBoardView({
      store,
      dispatch: (id, mode, sessionFileId) => this.chats.dispatch(id, mode, sessionFileId),
      openSession: (chatId) => {
        this.activateChat(chatId);
      },
      sessions: () =>
        this.chats.list().map((chat) => ({ fileId: chat.fileId, title: chat.title })),
      returnTask: (id, comment) => {
        this.fire(`the return of task ${id}`, this.chats.returnTask(id, comment));
      },
    }, focusId ?? null);
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

  /** Renders one streamed piece the core pushed for the active chat. The renders stay throttled, so
   * a long stream does not thrash the message list. A background chat already marked its tab unread. */
  private renderStreamed(chat: Chat, slot: ChatEntry): void {
    if (chat.id !== this.activeChatId) {
      return;
    }
    const now = Date.now();
    if (now - (this.streamRenders.get(chat.id) ?? 0) < STREAM_RENDER_INTERVAL) {
      return;
    }
    this.streamRenders.set(chat.id, now);
    this.patchStreamingEntry(chat, slot);
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
    return this.chats.isRunning(chatId);
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

  /** Opens one fresh chat in the core and activates its tab. */
  private async newChat(): Promise<void> {
    const chat = await this.chats.create();
    this.activateChat(chat.id);
  }

  private closeChat(id: number): void {
    const chat = this.chats.get(id);
    if (!chat) {
      return;
    }
    const index = this.chats.list().indexOf(chat);
    // The core closes the chat: its session file drops, a live task bound to it settles cancelled,
    // and its running turn stops. The pushed change removes the tab.
    this.fire(`the close of chat ${id}`, this.chats.close(id));
    if (this.activeChatId === id) {
      // The chat column keeps a chat: a neighbor takes over, or a fresh chat opens when none stays.
      const rest = this.chats.list().filter((candidate) => candidate.id !== id);
      const neighbor = rest[Math.min(index, rest.length - 1)];
      if (neighbor) {
        this.activateChat(neighbor.id);
      } else {
        void this.newChat();
      }
      return;
    }
    this.renderTabs();
  }

  private activateChat(id: number): void {
    this.activeChatId = id;
    // A freshly opened tab starts at its latest message.
    this.chatPinned = true;
    const chat = this.activeChat();
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
    // No owner, or a chat the core closed meanwhile, falls back to the active chat.
    const target = this.chats.get(owner ?? -1) ?? this.activeChat();
    if (target) {
      this.activateChat(target.id);
    }
  }

  /** Reads the active tab: the host tab, or one chat of the core. */
  private activeChat(): Chat | null {
    const id = this.activeChatId;
    // The host tab holds the id 0, so only a non-number id means no chat is active.
    if (typeof id !== 'number') {
      return null;
    }
    return (this.hostTab && this.hostTab.id === id ? this.hostTab : null) ?? this.chats.get(id);
  }

  /** Reads every tab: the host tab first when a client connected, then the chats in creation order. */
  private allChats(): readonly Chat[] {
    return this.hostTab ? [this.hostTab, ...this.chats.list()] : this.chats.list();
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
    for (const chat of this.allChats()) {
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
      const level: ThinkingLevel | null = value === 'low' || value === 'medium' || value === 'high' ? value : null;
      // The page view follows at once, and the core stores the pin with the chat.
      if (level) {
        chat.thinkingLevel = level;
      } else {
        delete chat.thinkingLevel;
      }
      this.fire(`the thinking level of chat ${chat.id}`, this.chats.setThinking(chat.id, level));
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
}
