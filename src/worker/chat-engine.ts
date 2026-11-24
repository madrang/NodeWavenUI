/**
 * The chat engine of the worker core: the chats, the agent turn loop, the provider calls, and the
 * task pump. It owns every chat of the workspace, so the turns survive a closed workspace window,
 * and the phone page sends into the same engine. The surfaces render from the state changes it
 * pushes on `chat.event` and steer it through the `chat.*` channels of the core contract
 * (`src/shared/core-api.ts`). The window tools and the MCP client stay in the main process: the
 * engine reaches them through the calls the worker sends there.
 */

import type {
  ChatImage,
  ChatMessage,
  CompletionDelta,
  InferenceProvider,
  ThinkingLevel,
  ToolCall,
} from '../providers/provider.js';
import type { OpenAiProviderConfig } from '../providers/openai.js';
import { CHAT_AGENT_SOURCE, agentToolRule, chatAgentSource } from '../shared/permissions.js';
import type { PathRule, PermissionRule } from '../shared/permissions.js';
import type { McpCallResult, McpNativeTool } from '../shared/mcp-endpoints.js';
import { presetOfAccount } from '../shared/provider-presets/index.js';
import { effectiveDefaultAccount, effectiveDefaultModel, modelDisplayName, modelVision } from '../shared/workspace.js';
import type { ProviderAccount, ProviderRegistry } from '../shared/workspace.js';
import type { TaskDispatchMode, TaskRecord } from '../shared/tasks.js';
import type { McpToolResult } from '../shared/window-tools.js';
import type {
  CoreAgentToolInfo,
  CoreChat,
  CoreChatEdit,
  CoreChatEntry,
  CoreChatEvent,
  CoreChatMeta,
  CoreChatPicks,
  CoreChatSend,
  CoreConnectionMenu,
  CoreEvent,
  CoreSystemPromptSourceInfo,
} from '../shared/core-api.js';
import { NONE_SYSTEM_PROMPT_SETUP_ID, defaultSystemPromptSetup } from '../shared/system-prompts.js';
import type { SystemPromptSource } from '../shared/system-prompts.js';
import type { WorkspaceSettingsStore } from '../storage/settings-store.js';
import {
  agentToolDefinition,
  availableAgentTools,
  buildAgentTools,
  type AgentMcpSurface,
  type AgentStorageShares,
  type AgentTool,
  type AgentToolDeps,
  type AgentToolOutput,
  type PermissionCheck,
} from './agent-tools.js';
import type { ChatEntry, ChatSessionStore, StoredChatSession, StoredSystemPrompt } from './chat-sessions.js';
import { log } from './logger.js';
import type { PatchNotice, PatchStore } from './patch-store.js';
import type { TaskStore } from './task-store.js';
import type { TaskToolDeps } from './task-tools.js';

/** The gate the engine needs: the permission check of the tools, and the rules the tool layer reads. */
export interface EngineGate extends PermissionCheck {
  listRules(): readonly PermissionRule[];
}

/** The services that stay in the main process: the window and command tools, and the MCP client.
 * The shape of `AgentMcpSurface` with the native tool list read from main, because the connections
 * live there. */
export interface EngineMainCalls {
  /** Runs one window or command tool as the agent principal. The source names the chat whose turn
   * sent the call, so the permission card lands in that chat's tab. */
  runWindowTool(name: string, args: Record<string, unknown>, source: string): Promise<McpToolResult>;
  /** Reads one resource of the MCP server that lists it. */
  readResource(uri: string): Promise<string>;
  /** Reads the native tool descriptors of the connected endpoints. */
  nativeTools(): Promise<readonly McpNativeTool[]>;
  /** Runs one native tool. */
  runNativeTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** The dependencies the engine builds from. */
export interface ChatEngineDeps {
  /** The absolute path of the workspace directory. */
  readonly workspacePath: string;
  /** The permission gate of the worker core. */
  readonly gate: EngineGate;
  /** The patch store of the worker core: every agent write proposes a patch here. */
  readonly patches: PatchStore;
  /** The task store of the worker core. */
  readonly tasks: TaskStore;
  /** The chat session store of the worker core, which persists every chat. */
  readonly chatSessions: ChatSessionStore;
  /** The settings store of the workspace: the provider registry, the turn limit, and the path rules. */
  readonly settings: WorkspaceSettingsStore;
  /** The storage sharing of the workspace, for the storage reads of the read tool. */
  readonly storageShares: AgentStorageShares;
  /** The system prompt sources a first send binds, in menu order. */
  readonly promptSources: readonly SystemPromptSource[];
  /** The services of the main process. */
  readonly main: EngineMainCalls;
  /** Builds the inference provider of one account. The specs inject a fake. */
  readonly createProvider: new (config: OpenAiProviderConfig) => InferenceProvider;
  /** Pushes one core event to every surface. */
  readonly emit: (event: CoreEvent) => void;
}

/** One chat of the engine: the state every surface reads, plus the entries it renders. */
interface EngineChat {
  readonly id: number;
  /** The session file id: one uuid per chat, stable across launches. */
  readonly fileId: string;
  readonly title: string;
  /** ISO date and time of the chat creation. It fixes the restore order. */
  readonly createdAt: string;
  readonly entries: ChatEntry[];
  /** The system prompt the chat bound on its first send. It stays for the life of the chat. */
  boundSystemPrompt?: StoredSystemPrompt;
  /** The provider and model the chat bound on its first send. They stay for the life of the chat. */
  boundProviderId?: string;
  boundModel?: string;
  /** The context tokens of the last request, when the provider reported usage. */
  contextTokens?: number;
  /** The output tokens of the whole chat, summed over the requests the provider reported. */
  outputTokens?: number;
  /** The reasoning effort of this chat. Unset follows the workspace default. */
  thinkingLevel?: ThinkingLevel;
  /** The dispatchable task this chat runs, set when a dispatch bound it. */
  taskId?: string;
  /** The draft task the chat was opened for, set at its creation. Its first send dispatches the task. */
  waitingTaskId?: string;
  /** Counts the state changes of the chat. Every pushed change carries it, so a surface drops a repeat. */
  revision: number;
}

/** The settings one turn reads when it starts. */
interface TurnSettings {
  readonly registry: ProviderRegistry;
  readonly pathRules: readonly PathRule[];
  /** How many provider rounds one message may spend on tool calls. Null means no limit. */
  readonly turnLimit: number | null;
  /** The default reasoning effort of the chats. Null means the endpoint default. */
  readonly thinkingDefault: ThinkingLevel | null;
}

/** The connection one chat runs on. */
interface ChatConnection {
  readonly account: ProviderAccount;
  readonly model: string;
  readonly vision: boolean;
}

/** Runs the chats of the workspace: the turns, the tools, the queue, and the task sessions. */
export class ChatEngine {
  private readonly deps: ChatEngineDeps;
  /** The chats of the workspace, in creation order. */
  private readonly chats: EngineChat[] = [];
  private nextChatId = 1;
  /** The abort controllers of the running agent turns, keyed by chat id, in start order. Chats
   * run their turns in parallel; one chat queues its own sends while its turn runs. */
  private readonly runningTurns = new Map<number, AbortController>();
  /** The task ids a dispatch holds in flight, so the store listener and the tool call never double-run one. */
  private readonly taskDispatching = new Set<string>();
  /** The nudge counts per task id: one nudge per running stretch, so a silent agent hears once. */
  private readonly taskNudges = new Map<string, number>();

  constructor(deps: ChatEngineDeps) {
    this.deps = deps;
  }

  /** Restores the stored sessions as chats in creation order, and re-links the runtime chat ids of
   * the bound task records: the persisted session files keep their binding, the numeric chat ids
   * start fresh. A live record whose session file never came back keeps its stale id and shows on
   * the board for a re-dispatch. Call once at boot, before any surface lists the chats. */
  async restore(): Promise<void> {
    const sessions = await this.deps.chatSessions.loadSessions();
    for (const session of sessions) {
      this.chats.push({
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
        revision: 0,
      });
      this.nextChatId += 1;
    }
    // The id counter also names new chats. A closed chat drops its file, so a restored title
    // can carry a number above the session count, and the counter must clear it.
    const highestChatNumber = Math.max(0, ...this.chats.map((chat) => Number(/^Chat (\d+)$/.exec(chat.title)?.[1] ?? 0)));
    this.nextChatId = Math.max(this.nextChatId, highestChatNumber + 1);
    for (const task of this.deps.tasks.list()) {
      if (!task.sessionFileId) {
        continue;
      }
      const chat = this.chatByFileId(task.sessionFileId);
      if (chat) {
        await this.deps.tasks.relink(task.id, chat.id);
      }
    }
  }

  /** Reads every chat whole, in creation order: the snapshot a surface starts from. */
  list(): readonly CoreChat[] {
    return this.chats.map((chat) => this.viewOf(chat));
  }

  /** Reads one chat whole, or null when the core holds no chat of that id. */
  get(chatId: number): CoreChat | null {
    const chat = this.chatById(chatId);
    return chat ? this.viewOf(chat) : null;
  }

  /** True while one chat runs an agent turn. */
  isRunning(chatId: number): boolean {
    return this.runningTurns.has(chatId);
  }

  /** Opens one fresh chat. It holds no session file until its first entry lands. A task id names the
   * draft task the chat waits for: the chat takes the title of the task, and its first send
   * dispatches the task into the chat.
   *
   * @param taskId The draft task the chat waits for. A missing id opens a plain chat.
   * @returns The new chat.
   * @throws Error when the task is missing or is no draft.
   */
  create(taskId?: string): CoreChat {
    const waiting = taskId ? this.deps.tasks.get(taskId) : null;
    if (taskId && (!waiting || waiting.status !== 'draft')) {
      throw new Error(`The task ${taskId} is missing or is no draft, so no chat can wait for it.`);
    }
    const chat: EngineChat = {
      id: this.nextChatId,
      fileId: crypto.randomUUID(),
      title: waiting ? waiting.title : `Chat ${this.nextChatId}`,
      createdAt: new Date().toISOString(),
      entries: [],
      ...(waiting ? { waitingTaskId: waiting.id } : {}),
      revision: 0,
    };
    this.nextChatId += 1;
    this.chats.push(chat);
    const view = this.viewOf(chat);
    this.deps.emit({ channel: 'chat.event', payload: { kind: 'chat', chat: view } satisfies CoreChatEvent });
    return view;
  }

  /** Closes one chat: it leaves the list, its session file drops so a restart does not resurrect
   * it, a live task bound to it settles cancelled, and a turn that still runs on it stops. */
  close(chatId: number): void {
    const index = this.chats.findIndex((chat) => chat.id === chatId);
    if (index < 0) {
      return;
    }
    const [chat] = this.chats.splice(index, 1);
    if (!chat) {
      return;
    }
    this.deps.chatSessions.deleteSession(chat.fileId);
    if (chat.taskId) {
      const task = this.deps.tasks.get(chat.taskId);
      if (task && (task.status === 'running' || task.status === 'queued') && task.sessionFileId === chat.fileId) {
        void this.deps.tasks.cancel(task.id, 'The session tab closed.');
      }
    }
    // No surface renders the closed chat, so its turn must not spend provider calls on it.
    this.runningTurns.get(chat.id)?.abort();
    this.deps.emit({ channel: 'chat.event', payload: { kind: 'closed', chatId } satisfies CoreChatEvent });
  }

  /**
   * Delivers one message of a surface. A running turn queues the message as a dimmed entry that
   * delivers when the turn ends. A chat that waits for a task sends without a text: the brief of
   * the task is its message.
   *
   * @param call The send: the chat, the text, the images, and the connection picks of a first send.
   * @returns True when the message landed. False when the chat holds nothing to send, or when a
   * notice entry explains the refusal: the text stays with the surface.
   */
  async send(call: CoreChatSend): Promise<boolean> {
    const chat = this.chatById(call.chatId);
    const waiting = chat ? this.waitingTask(chat) : null;
    if (!chat || (call.text.length === 0 && call.images.length === 0 && !waiting)) {
      return false;
    }
    if (this.isRunning(chat.id)) {
      // The agent of this chat runs: the message waits as a dimmed entry and delivers when the run ends.
      this.pushEntry(chat, {
        role: 'user',
        content: call.text,
        ...(call.images.length > 0 ? { images: call.images } : {}),
        queued: true,
      });
      return true;
    }
    return this.deliver(chat, call.text, call.images, call, waiting ?? undefined);
  }

  /** Lands one remote send: the chat of the named session file takes the message, the newest chat
   * when the sender named none. A running turn queues the message like a local send does. The picks
   * reach the first send of the chat, the way the menu of the workspace page does. A chat that
   * waits for a task sends without a text. */
  remoteSend(fileId: string | null, text: string, picks?: CoreChatPicks): void {
    const chat = (fileId ? this.chatByFileId(fileId) : null) ?? this.chats.at(-1) ?? null;
    const waiting = chat ? this.waitingTask(chat) : null;
    if (!chat || (text.trim().length === 0 && !waiting)) {
      return;
    }
    if (this.isRunning(chat.id)) {
      this.pushEntry(chat, { role: 'user', content: text, queued: true });
      return;
    }
    this.unattended(`the turn of chat ${chat.id}`, this.deliver(chat, text.trim(), [], picks, waiting ?? undefined));
  }

  /** Closes the chat of the named session file, the way the close of a tab does: it leaves the
   * list, its session file drops, a live task bound to it settles cancelled, and a running turn
   * stops. An unknown session file closes nothing. */
  remoteClose(fileId: string): void {
    const chat = this.chatByFileId(fileId);
    if (chat) {
      this.close(chat.id);
    }
  }

  /** Stops the running turn of one chat. The streamed part stays, and a `Stopped.` notice lands. */
  stop(chatId: number): void {
    this.runningTurns.get(chatId)?.abort();
  }

  /** Restarts the failed turn of one user message: every entry after the message drops, and the
   * turn runs again, so the failed message sends again from that exact point. */
  retry(chatId: number, index: number): void {
    const chat = this.chatById(chatId);
    if (!chat || this.isRunning(chat.id) || !chat.entries[index]) {
      return;
    }
    this.spliceEntries(chat, index + 1, chat.entries.length - index - 1, []);
    this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat));
  }

  /** Copies the history before one user message into a new chat. The source chat keeps its whole
   * conversation. The fork holds no session file until its own first entry lands. */
  fork(chatId: number, index: number): CoreChat | null {
    const chat = this.chatById(chatId);
    if (!chat || !chat.entries[index]) {
      return null;
    }
    const fork: EngineChat = {
      id: this.nextChatId,
      fileId: crypto.randomUUID(),
      title: `${chat.title} fork`,
      createdAt: new Date().toISOString(),
      entries: chat.entries.slice(0, index).map((entry) => ({ ...entry })),
      ...(chat.boundProviderId ? { boundProviderId: chat.boundProviderId } : {}),
      ...(chat.boundModel ? { boundModel: chat.boundModel } : {}),
      ...(chat.boundSystemPrompt ? { boundSystemPrompt: chat.boundSystemPrompt } : {}),
      ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
      revision: 0,
    };
    this.nextChatId += 1;
    this.chats.push(fork);
    const view = this.viewOf(fork);
    this.deps.emit({ channel: 'chat.event', payload: { kind: 'chat', chat: view } satisfies CoreChatEvent });
    return view;
  }

  /** Sends the edited draft: the history from the edited message on drops, the draft replaces the
   * message, and the turn restarts from there. A fork draft appends to the copied history. */
  async edit(call: CoreChatEdit): Promise<void> {
    const chat = this.chatById(call.chatId);
    if (!chat || this.isRunning(chat.id)) {
      return;
    }
    const target = typeof call.index === 'number' ? chat.entries[call.index] : undefined;
    const images = call.images ?? target?.images ?? [];
    if (call.text.length === 0 && images.length === 0) {
      return;
    }
    if (this.chatNeedsSystemPrompt(chat)) {
      // A fork draft at the head of its tab is a first message, so the menu choice binds here too.
      if (!(await this.bindChatSystemPrompt(chat, call.systemPromptId))) {
        return;
      }
    }
    const at = call.index ?? chat.entries.length;
    this.spliceEntries(chat, at, chat.entries.length - at, [
      { role: 'user', content: call.text, ...(images.length > 0 ? { images } : {}) },
    ]);
    this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat));
  }

  /** Sends one queued message at once. While a turn runs, the entry un-queues into the next
   * request of that turn, so it goes out without waiting for the turn to end. Without a running
   * turn it delivers immediately. */
  async sendNow(chatId: number, index: number): Promise<void> {
    const chat = this.chatById(chatId);
    const entry = chat?.entries[index];
    if (!chat || !entry || entry.role !== 'user' || !entry.queued) {
      return;
    }
    this.spliceEntries(chat, index, 1, []);
    if (this.isRunning(chat.id)) {
      this.pushEntry(chat, {
        role: 'user',
        content: entry.content,
        ...(entry.images && entry.images.length > 0 ? { images: entry.images } : {}),
        // False, not absent: the drain after the run answers it when the turn ends without it.
        queued: false,
      });
      this.persistChat(chat);
      return;
    }
    await this.deliver(chat, entry.content, entry.images ?? []);
  }

  /** Sets the reasoning effort of one chat. Null clears the pin, so the workspace default applies. */
  setThinking(chatId: number, level: ThinkingLevel | null): void {
    const chat = this.chatById(chatId);
    if (!chat) {
      return;
    }
    if (level) {
      chat.thinkingLevel = level;
    } else {
      delete chat.thinkingLevel;
    }
    this.persistChat(chat);
    this.metaChanged(chat);
  }

  /** Lands one notice entry in one chat, for a refusal a surface explains in the transcript. The
   * chat agent never reads a notice: the next request skips it. A null chat id names the newest chat. */
  notice(chatId: number | null, text: string): void {
    // The host tab of a page holds the id 0 and never reaches the core, so a falsy id names the newest chat.
    const chat = (chatId ? this.chatById(chatId) : null) ?? this.chats.at(-1) ?? null;
    if (!chat) {
      return;
    }
    this.pushEntry(chat, { role: 'notice', content: text });
    this.persistChat(chat);
  }

  /** Lands one notification as a user message in one chat, so the chat agent sees it on its next
   * turn. A null chat id names the newest chat. */
  notify(chatId: number | null, text: string): void {
    const chat = (chatId ? this.chatById(chatId) : null) ?? this.chats.at(-1) ?? null;
    if (!chat) {
      return;
    }
    this.pushEntry(chat, { role: 'user', content: text });
    this.persistChat(chat);
  }

  /** Reads the tools the agent may call, the built-ins plus the native MCP tools, without the
   * disabled ones: the list of the settings matrix. */
  async listTools(): Promise<readonly CoreAgentToolInfo[]> {
    const settings = await this.loadTurnSettings();
    const tools = availableAgentTools(this.agentToolDeps(settings, await this.deps.main.nativeTools()));
    return tools.map(({ name, description }) => ({ name, description }));
  }

  /** Reads the system prompt sources a first send binds, in menu order: the list the phone page offers. */
  promptSources(): readonly CoreSystemPromptSourceInfo[] {
    return this.deps.promptSources.map(({ id, label }) => ({ id, label }));
  }

  /** Reads the connection menu a first send picks from: every account with its models, and the
   * defaults of the registry. No key and no address ride along. */
  async connectionMenu(): Promise<CoreConnectionMenu> {
    const registry = await this.deps.settings.loadProviderRegistry();
    return {
      accounts: registry.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        models: account.models.map((model) => ({ id: model.id, label: modelDisplayName(account, model.id) })),
      })),
      defaultProviderId: registry.defaultProviderId,
      defaultModel: registry.defaultModel,
    };
  }

  /**
   * Dispatches one queued task onto its session. A new-session dispatch opens the chat; a session
   * dispatch hands the task to its bound chat when that chat sits idle. A busy chat and a blocked
   * task keep the record queued, and the pump takes them when their turn comes.
   *
   * @param id The record id.
   * @param mode How the dispatch binds the session.
   * @param sessionFileId The chat session file, on session mode.
   * @param waitsForTurn True waits for the turn of the session before the answer, the way the
   * `tasks` tool call always did. False launches the turn and answers at once, for the task board.
   * @returns The outcome text the agent or the board reads.
   */
  async dispatch(
    id: string,
    mode: TaskDispatchMode,
    sessionFileId: string | null,
    waitsForTurn = true,
  ): Promise<string> {
    const store = this.deps.tasks;
    if (this.taskDispatching.has(id)) {
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
      let chat: EngineChat;
      let outcome: string;
      if (mode === 'session') {
        const bound = sessionFileId ? this.chatByFileId(sessionFileId) : null;
        if (!bound) {
          return `The chat session ${sessionFileId ?? '(none)'} holds no open tab. The task stays queued.`;
        }
        if (this.isRunning(bound.id)) {
          return 'The session runs a turn. The task stays queued and enters when it idles.';
        }
        chat = bound;
        outcome = `The task entered the session "${chat.title}".`;
      } else {
        chat = this.openTaskChat(task);
        outcome = 'A new chat session opened for the task.';
      }
      await this.handTaskOver(chat, task);
      if (this.isRunning(chat.id)) {
        return outcome;
      }
      if (waitsForTurn) {
        await this.runChatTurn(chat);
      } else {
        this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat));
      }
      return outcome;
    } finally {
      this.taskDispatching.delete(id);
    }
  }

  /** Returns one review to its session: the record moves back to running and the comment of the
   * user rides to the session agent as a re-brief. The turn of the session runs on its own. */
  async returnTask(id: string, comment: string | null): Promise<void> {
    const task = this.deps.tasks.get(id);
    const chat = task ? this.chatOfTask(task) : null;
    const returned = await this.deps.tasks.returnToSession(id);
    if (!returned || !chat) {
      return;
    }
    this.unattended(
      `the return of task ${id}`,
      this.deliverTaskNotice(
        chat,
        `[task ${id}] The user returned the task with a comment:${comment ? `\n${comment}` : ''}\nAddress the comment, then call the tasks tool with action complete again.`,
      ),
    );
  }

  /** Delivers one patch notice into its chat: the entry lands for the next loop step, and an idle
   * chat starts a turn to process it. The turn runs on its own. */
  deliverPatchNotice(notice: PatchNotice): void {
    const chat = this.chatById(notice.chatId);
    if (!chat) {
      return;
    }
    this.pushEntry(chat, { role: 'user', content: notice.text });
    this.persistChat(chat);
    if (!this.isRunning(chat.id)) {
      this.unattended(`the patch notice of chat ${chat.id}`, this.runChatTurn(chat));
    }
  }

  /** Tells the origin chat of one task settle it did not cause, so a waiting parent learns the
   * outcome. The turn of the origin chat runs on its own. */
  deliverTaskSettle(task: TaskRecord): void {
    this.taskNudges.delete(task.id);
    const origin = task.originChatId ? this.chatById(task.originChatId) : null;
    if (!origin || origin.id === task.sessionChatId) {
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
    const text = `[task settle] ${head}${task.result ? `\nResult: ${task.result}` : ''}`;
    if (this.isRunning(origin.id)) {
      // A running turn reads the entry at its next loop step.
      this.pushEntry(origin, { role: 'user', content: text });
      this.persistChat(origin);
      return;
    }
    this.unattended(`the settle notice of task ${task.id}`, this.deliverTaskNotice(origin, text));
  }

  /** Persists one chat as its session file. A chat without entries holds nothing worth a file, and
   * a closed chat left the list: a turn that still winds down must not write its file back. */
  private persistChat(chat: EngineChat): void {
    if (chat.entries.length === 0 || !this.chats.includes(chat)) {
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
    this.deps.chatSessions.saveSession(session);
  }

  /** Delivers one message: resolves the connection, binds the system prompt, hands the task the
   * chat waits for over, pushes the entry, and starts the agent turn. The picks bind on a first send.
   *
   * @param chat The chat that takes the message.
   * @param text The text of the message. Empty when a task alone sends.
   * @param images The images of the message.
   * @param picks The provider, the model, and the system prompt source of a first send.
   * @param task The draft task the chat waits for. The send dispatches it into the chat.
   * @returns True when the message landed and the turn started. False when a notice or error entry
   * explains the refusal.
   */
  private async deliver(
    chat: EngineChat,
    text: string,
    images: readonly ChatImage[],
    picks?: CoreChatPicks,
    task?: TaskRecord,
  ): Promise<boolean> {
    const settings = await this.loadTurnSettings();
    const connection = this.resolveChatConnection(chat, settings, picks);
    if (connection && images.length > 0 && !connection.vision) {
      // Nothing is consumed: the text stays typed and the chips stay pending, so the user can switch model or remove the images.
      this.pushEntry(chat, {
        role: 'notice',
        content: `The model "${connection.model}" reads text only. Turn on its Vision flag in the settings, or remove the images.`,
      });
      this.persistChat(chat);
      return false;
    }
    // Only a chat without messages binds a prompt. An old chat keeps running without one.
    // The bind sits past the rejected-send guards, so a send that never reaches the transcript leaves the menu open.
    if (this.chatNeedsSystemPrompt(chat)) {
      // The first send binds the prompt source and snapshots its text, so the chat keeps what it sent.
      if (!(await this.bindChatSystemPrompt(chat, picks?.systemPromptId))) {
        return false;
      }
    }
    if (task) {
      const claimed = await this.claimWaitingTask(chat, task);
      // A task alone sends nothing when its claim refused: the notice explains why.
      if (!claimed && text.length === 0 && images.length === 0) {
        return false;
      }
    }
    if (text.length > 0 || images.length > 0) {
      this.pushEntry(chat, { role: 'user', content: text, ...(images.length > 0 ? { images } : {}) });
    }
    this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat, settings, picks));
    return true;
  }

  /** True when the chat already carries a sent message, so its system prompt window has passed. */
  private chatHasConversation(chat: EngineChat): boolean {
    return chat.entries.some((entry) => entry.role === 'user' || entry.role === 'assistant');
  }

  /** True while a chat sits before its first sent message, so its system prompt window is open. */
  private chatNeedsSystemPrompt(chat: EngineChat): boolean {
    return !chat.boundSystemPrompt && !this.chatHasConversation(chat);
  }

  /** Binds the system prompt of a chat that sits before its first message: the menu choice snapshots
   * its text into the chat, so the chat keeps what it sent. A chat that picks no source binds the
   * none prompt.
   *
   * @param chat The chat that sends its first message.
   * @param sourceId The source the menu holds, or undefined for the default of the workspace.
   * @returns True when the chat holds a prompt. False when the source build failed; its error entry landed.
   */
  private async bindChatSystemPrompt(chat: EngineChat, sourceId?: string): Promise<boolean> {
    // The source the menu holds: the given pick, or the default. The none source binds no prompt.
    const sources = this.deps.promptSources;
    const wanted = sourceId || defaultSystemPromptSetup(sources)?.id || NONE_SYSTEM_PROMPT_SETUP_ID;
    const setup =
      wanted === NONE_SYSTEM_PROMPT_SETUP_ID ?
        null :
        (sources.find((source) => source.id === wanted) ?? defaultSystemPromptSetup(sources));
    if (!setup) {
      chat.boundSystemPrompt = { sourceId: NONE_SYSTEM_PROMPT_SETUP_ID, title: 'No system prompt', text: '' };
      this.metaChanged(chat);
      return true;
    }
    let promptText: string;
    try {
      promptText = await setup.build({ workspacePath: this.deps.workspacePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEntry(chat, {
        role: 'error',
        content: `The system prompt source "${setup.label}" failed: ${message}`,
      });
      return false;
    }
    chat.boundSystemPrompt = { sourceId: setup.id, title: setup.label, text: promptText };
    this.metaChanged(chat);
    return true;
  }

  /** Reads the settings one turn reads, fresh from the store so an edit of the pane applies to the next turn. */
  private async loadTurnSettings(): Promise<TurnSettings> {
    return {
      registry: await this.deps.settings.loadProviderRegistry(),
      pathRules: await this.deps.settings.loadPathRules(),
      turnLimit: await this.deps.settings.loadAgentTurnLimit(),
      thinkingDefault: await this.deps.settings.loadAgentThinking(),
    };
  }

  /** The connection one chat runs on: its bound provider and model, or the picks of the surface
   * and the defaults of the registry. Null when the chat has no usable provider, or when its bound
   * provider no longer exists. */
  private resolveChatConnection(
    chat: EngineChat,
    settings: TurnSettings,
    picks?: CoreChatPicks,
  ): ChatConnection | null {
    const registry = settings.registry;
    if (chat.boundProviderId) {
      const account = registry.accounts.find((candidate) => candidate.id === chat.boundProviderId);
      if (!account || !chat.boundModel) {
        return null;
      }
      return { account, model: chat.boundModel, vision: modelVision(account, chat.boundModel) };
    }
    const account =
      registry.accounts.find((candidate) => candidate.id === picks?.providerId) ?? effectiveDefaultAccount(registry);
    if (!account) {
      return null;
    }
    const model =
      picks?.model && account.models.some((candidate) => candidate.id === picks.model) ?
        picks.model :
        effectiveDefaultModel(registry, account);
    if (!model) {
      return null;
    }
    return { account, model, vision: modelVision(account, model) };
  }

  /** Runs one agent turn that answers the latest user message of the chat: resolves the connection,
   * streams the reply, records the outcome, and delivers the queue. The send, the retry of a failed
   * turn, and the resend of an edited message all land here.
   *
   * @param chat The chat that runs the turn.
   * @param preloaded The settings of the turn, when the caller read them already.
   * @param picks The connection picks of a first send. A later turn reads the bound provider and model.
   */
  private async runChatTurn(chat: EngineChat, preloaded?: TurnSettings, picks?: CoreChatPicks): Promise<void> {
    const settings = preloaded ?? await this.loadTurnSettings();
    const connection = this.resolveChatConnection(chat, settings, picks);
    if (!connection) {
      this.pushEntry(chat, {
        role: chat.boundProviderId ? 'error' : 'notice',
        content: chat.boundProviderId ?
          'The provider of this chat no longer exists. Open a new chat tab for a different model.' :
          'No provider is configured. Open the Settings tab, add a provider, and give it a model.',
      });
      this.persistChat(chat);
      return;
    }
    const preset = presetOfAccount(connection.account);
    const provider = new this.deps.createProvider({
      baseUrl: connection.account.baseUrl,
      apiKey: connection.account.apiKey,
      ...(preset?.beforeRequest ? { beforeRequest: preset.beforeRequest } : {}),
    });
    if (!chat.boundProviderId) {
      // The first send binds the chat to this provider and model, and locks the status bar.
      chat.boundProviderId = connection.account.id;
      chat.boundModel = connection.model;
      this.metaChanged(chat);
    }
    const abort = new AbortController();
    this.runningTurns.set(chat.id, abort);
    this.metaChanged(chat);
    let stopped = false;
    try {
      await this.runAgentTurn(
        chat,
        provider,
        connection.model,
        connection.vision,
        settings,
        chat.thinkingLevel ?? settings.thinkingDefault ?? undefined,
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
              this.spliceEntries(chat, index, 1, []);
            }
            break;
          }
        }
        this.pushEntry(chat, { role: 'notice', content: 'Stopped.' });
      } else {
        this.pushEntry(chat, {
          role: 'error',
          content: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.runningTurns.get(chat.id) === abort) {
        this.runningTurns.delete(chat.id);
      }
      this.persistChat(chat);
      // The state change closes the turn: it follows the last entry, so a surface renders the end once.
      this.metaChanged(chat);
    }
    // A stop leaves the queue in place: the user halted the agent, so nothing follows on its own.
    if (stopped) {
      return;
    }
    await this.drainQueued(chat);
    await this.afterTaskTurn(chat);
  }

  /** Lets one engine promise run on its own, so a failure outside a request reaches the log. */
  private unattended(label: string, work: Promise<unknown>): void {
    void work.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.worker.chat.error(`${label} failed: ${message}`);
    });
  }

  /** Pumps the task queue after one record change: opens sessions and hands idle chats their next
   * ready queued task. */
  pumpTasks(): void {
    this.unattended('the task queue pump', this.pumpQueuedTasks());
  }

  /** Delivers the first waiting message of a chat after a finished run: one still queued, or a
   * send-now entry the finished turn never answered. The entry moves to the end as it delivers. */
  private async drainQueued(chat: EngineChat): Promise<void> {
    const index = chat.entries.findIndex((entry) => entry.role === 'user' && entry.queued);
    const queued = index >= 0 ? chat.entries[index] : undefined;
    if (queued) {
      this.spliceEntries(chat, index, 1, []);
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
        this.spliceEntries(chat, position, 1, []);
        await this.deliver(chat, entry.content, entry.images ?? []);
        return;
      }
    }
  }

  /** The dependencies the agent tools build from. A running turn passes its chat, so the permission
   * requests attribute to that chat. The settings matrix lists the tools without one. */
  private agentToolDeps(
    settings: TurnSettings,
    nativeTools: readonly McpNativeTool[],
    chat?: EngineChat,
  ): AgentToolDeps {
    const main = this.deps.main;
    const mcpClients: AgentMcpSurface = {
      readResource: (uri) => main.readResource(uri),
      nativeTools: () => nativeTools,
      runNativeTool: (name, args) => main.runNativeTool(name, args),
    };
    return {
      gate: this.deps.gate,
      mcpClients,
      runWindowTool: (name, args, source) => main.runWindowTool(name, args, source),
      workspacePath: this.deps.workspacePath,
      storageShares: this.deps.storageShares,
      toolRules: () => this.deps.gate.listRules(),
      source: chat ? chatAgentSource(chat.id) : CHAT_AGENT_SOURCE,
      chatId: chat?.id ?? 0,
      sessionFileId: chat?.fileId ?? null,
      patchStore: this.deps.patches,
      pathRules: () => settings.pathRules,
      tasks: this.taskToolDeps(settings, nativeTools, chat),
    };
  }

  /** The deps of the tasks tool: the store, the session and naming callbacks of the engine, and the
   * permission surface the dispatch action asks through. */
  private taskToolDeps(settings: TurnSettings, nativeTools: readonly McpNativeTool[], chat?: EngineChat): TaskToolDeps {
    const chatId = chat?.id ?? 0;
    return {
      store: this.deps.tasks,
      dispatch: (id, mode, sessionFileId) => this.dispatch(id, mode, sessionFileId),
      send: (id, message) => this.sendTask(id, message),
      setTaskName: async (title, description, amend) => {
        if (!amend && !title) {
          throw new Error('A new task needs a title. Pass amend true to change the open task.');
        }
        if (amend && !this.deps.patches.openTask(chatId)) {
          throw new Error('No open task to amend. Start one without amend.');
        }
        const task = await this.deps.patches.setTask(chatId, title, description, amend);
        return amend ? `The task now reads "${task.title}".` : `The task "${task.title}" started.`;
      },
      chatId,
      check: this.deps.gate,
      dispatchAllowed: () => agentToolRule('tasks', this.deps.gate.listRules())?.effect === 'allow',
      source: chat ? chatAgentSource(chat.id) : CHAT_AGENT_SOURCE,
    };
  }

  /** Delivers one task message into a chat: the entry lands for the next loop step, and an idle
   * chat starts a turn to process it. Task briefs, nudges, settles, and sends all ride this. */
  private async deliverTaskNotice(chat: EngineChat, text: string): Promise<void> {
    this.pushEntry(chat, { role: 'user', content: text });
    this.persistChat(chat);
    if (!this.isRunning(chat.id)) {
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

  /** Opens the chat a new-session dispatch runs in, named after the task. */
  private openTaskChat(task: TaskRecord): EngineChat {
    const chat: EngineChat = {
      id: this.nextChatId,
      fileId: crypto.randomUUID(),
      title: task.title,
      createdAt: new Date().toISOString(),
      entries: [],
      taskId: task.id,
      revision: 0,
    };
    this.nextChatId += 1;
    this.chats.push(chat);
    this.deps.emit({ channel: 'chat.event', payload: { kind: 'chat', chat: this.viewOf(chat) } satisfies CoreChatEvent });
    return chat;
  }

  /** The draft task one chat waits for, or null: the chat waits for none, or the task left the draft state. */
  private waitingTask(chat: EngineChat): TaskRecord | null {
    if (!chat.waitingTaskId) {
      return null;
    }
    const task = this.deps.tasks.get(chat.waitingTaskId);
    return task && task.status === 'draft' ? task : null;
  }

  /** Hands the task a chat waits for over to that chat, as a step of the first send of the chat.
   * The record joins the queue of the chat, then binds it and lands the brief. A blocked task keeps
   * its place in that queue, and the pump hands it over when its blockers settle. The chat stops
   * waiting in every case.
   *
   * @param chat The chat that waits for the task.
   * @param task The draft task.
   * @returns True when the brief landed and the turn may run. False when the record left the draft
   * state or waits for its blockers: a notice entry explains it.
   */
  private async claimWaitingTask(chat: EngineChat, task: TaskRecord): Promise<boolean> {
    delete chat.waitingTaskId;
    // The pump skips the task while this claim holds it, so no second chat opens for it.
    this.taskDispatching.add(task.id);
    try {
      const queued = await this.deps.tasks.dispatch(task.id, 'session', chat.fileId);
      if (!queued) {
        this.pushEntry(chat, { role: 'notice', content: `The task ${task.id} is no longer a draft. Nothing was sent.` });
        this.persistChat(chat);
        this.metaChanged(chat);
        return false;
      }
      if (!this.deps.tasks.ready(queued)) {
        this.pushEntry(chat, {
          role: 'notice',
          content: `The task ${task.id} waits for its blockedBy tasks: ${queued.blockedBy.join(', ')}. It enters this chat when they are done.`,
        });
        this.persistChat(chat);
        this.metaChanged(chat);
        return false;
      }
      await this.handTaskOver(chat, queued);
      return true;
    } finally {
      this.taskDispatching.delete(task.id);
    }
  }

  /** Binds one chat to a task, names its work, and pushes the brief. The turn of the session starts
   * with the dispatch that called this. */
  private async handTaskOver(chat: EngineChat, task: TaskRecord): Promise<void> {
    chat.taskId = task.id;
    this.metaChanged(chat);
    await this.deps.tasks.bindSession(task.id, chat.id, chat.fileId);
    // The session names its work after the record, so the patches of the run group under the task
    // title and the tab reads it.
    await this.deps.patches.setTask(chat.id, task.title, task.description, false);
    this.pushEntry(chat, { role: 'user', content: this.taskBrief(task) });
    this.persistChat(chat);
  }

  /** Opens sessions and hands idle chats their next ready queued task. Runs on every record change. */
  private async pumpQueuedTasks(): Promise<void> {
    const store = this.deps.tasks;
    for (const task of store.list()) {
      if (task.status !== 'queued' || this.taskDispatching.has(task.id) || !store.ready(task)) {
        continue;
      }
      if (task.dispatchMode === 'new-session' && !task.sessionFileId) {
        await this.dispatch(task.id, 'new-session', null);
        continue;
      }
      if (task.dispatchMode === 'session' && task.sessionFileId) {
        const chat = this.chatByFileId(task.sessionFileId);
        if (chat && !this.isRunning(chat.id)) {
          await this.dispatch(task.id, 'session', task.sessionFileId);
        }
      }
    }
  }

  /** Handles the task of one chat after its turn: one nudge on a silent running task, and the
   * queue pump when the task settled so the next one enters. */
  private async afterTaskTurn(chat: EngineChat): Promise<void> {
    const store = this.deps.tasks;
    if (!chat.taskId) {
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

  /** Finds the chat one task record is bound to in this app run. */
  private chatOfTask(task: TaskRecord): EngineChat | null {
    return task.sessionChatId ? (this.chatById(task.sessionChatId) ?? null) : null;
  }

  /** Sends one message into the session of a task. A busy session queues the entry for its drain. */
  private async sendTask(id: string, message: string): Promise<string> {
    const task = this.deps.tasks.get(id);
    if (!task) {
      return 'The task does not exist.';
    }
    const chat = this.chatOfTask(task);
    if (!chat) {
      return 'The task holds no open session tab.';
    }
    if (this.isRunning(chat.id)) {
      this.pushEntry(chat, { role: 'user', content: `[task ${id}] ${message}`, queued: true });
      this.persistChat(chat);
      return 'The session runs a turn. The message queued and delivers when it ends.';
    }
    await this.deliverTaskNotice(chat, `[task ${id}] ${message}`);
    return 'The message entered the session.';
  }

  /** The tools the agent may call this turn, the built-ins plus the native MCP tools, without the
   * disabled ones. The turn's chat scopes the permission requests. */
  private async agentTools(chat: EngineChat, settings: TurnSettings): Promise<readonly AgentTool[]> {
    return buildAgentTools(this.agentToolDeps(settings, await this.deps.main.nativeTools(), chat));
  }

  /** Runs the tool-calling loop of one user message, until the model answers in text or hits the round limit. */
  private async runAgentTurn(
    chat: EngineChat,
    provider: InferenceProvider,
    model: string,
    vision: boolean,
    settings: TurnSettings,
    thinkingLevel: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let turn = 0;
    const limit = settings.turnLimit;
    while (typeof limit !== 'number' || turn < limit) {
      turn += 1;
      const tools = await this.agentTools(chat, settings);
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
        this.metaChanged(chat);
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
    this.pushEntry(chat, {
      role: 'error',
      content: `The agent exceeded ${limit} tool rounds in one message.`,
    });
  }

  /** Runs one tool call of the agent and appends the result entry the next request retransmits. */
  private async runAgentToolCall(chat: EngineChat, tools: readonly AgentTool[], call: ToolCall): Promise<void> {
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
    this.pushEntry(chat, {
      role: 'tool',
      content: output.text,
      ...(json ? { json } : {}),
      ...(output.images && output.images.length > 0 ? { images: output.images } : {}),
      toolCallId: call.id,
      toolName: call.name,
    });
    // The turn runs on, so the result lands in the session file now: a crash mid-turn keeps it.
    this.persistChat(chat);
  }

  /** Reads the entries of one chat as the message list of the next provider request. */
  private agentMessages(chat: EngineChat, vision: boolean): ChatMessage[] {
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

  /** Opens one in-flight assistant entry that streams the reply, and settles it with the final entry.
   * The entry is tracked by identity, because a message queued mid-run appends after it. Every
   * streamed piece pushes as one delta, so a surface appends it to the entry at its index. */
  private beginStreamingEntry(chat: EngineChat): {
    onDelta: (delta: CompletionDelta) => void;
    settle: (entry: ChatEntry) => void;
  } {
    let liveContent = '';
    let liveReasoning = '';
    // The slot is tracked through its replacements, because a message queued mid-run appends after it.
    let slot: ChatEntry = { role: 'assistant', content: '' };
    this.pushEntry(chat, slot);
    const replaceSlot = (next: ChatEntry): void => {
      const index = chat.entries.indexOf(slot);
      if (index >= 0) {
        chat.entries[index] = next;
        slot = next;
      }
    };
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
        const index = chat.entries.indexOf(slot);
        if (index < 0 || !this.chats.includes(chat)) {
          return;
        }
        this.deps.emit({
          channel: 'chat.event',
          payload: {
            kind: 'delta',
            chatId: chat.id,
            revision: chat.revision,
            index,
            ...(delta.content ? { content: delta.content } : {}),
            ...(delta.reasoning ? { reasoning: delta.reasoning } : {}),
          } satisfies CoreChatEvent,
        });
      },
      settle: (entry: ChatEntry): void => {
        const index = chat.entries.indexOf(slot);
        if (index >= 0) {
          this.spliceEntries(chat, index, 1, [entry]);
        } else {
          this.pushEntry(chat, entry);
        }
      },
    };
  }

  /** Reads the wire state of one chat, without its entries. */
  private metaOf(chat: EngineChat): CoreChatMeta {
    // The chat waits only while its task is a draft: a record that left the draft state never wakes it.
    const waiting =
      chat.waitingTaskId && this.deps.tasks.get(chat.waitingTaskId)?.status === 'draft' ? chat.waitingTaskId : undefined;
    return {
      id: chat.id,
      fileId: chat.fileId,
      title: chat.title,
      createdAt: chat.createdAt,
      ...(chat.boundProviderId ? { boundProviderId: chat.boundProviderId } : {}),
      ...(chat.boundModel ? { boundModel: chat.boundModel } : {}),
      // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence drops the field
      ...(chat.contextTokens !== undefined ? { contextTokens: chat.contextTokens } : {}),
      // eslint-disable-next-line local/prefer-truthiness -- zero tokens is a real recorded usage, only absence drops the field
      ...(chat.outputTokens !== undefined ? { outputTokens: chat.outputTokens } : {}),
      ...(chat.boundSystemPrompt ? { systemPrompt: chat.boundSystemPrompt } : {}),
      ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
      ...(chat.taskId ? { taskId: chat.taskId } : {}),
      ...(waiting ? { waitingTaskId: waiting } : {}),
      running: this.isRunning(chat.id),
      revision: chat.revision,
    };
  }

  /** Reads one chat whole: its state and a snapshot of its entries. */
  private viewOf(chat: EngineChat): CoreChat {
    return { ...this.metaOf(chat), entries: [...chat.entries] };
  }

  /** Records one change of the state of a chat and pushes it. */
  private metaChanged(chat: EngineChat): void {
    chat.revision += 1;
    if (this.chats.includes(chat)) {
      this.deps.emit({ channel: 'chat.event', payload: { kind: 'meta', chat: this.metaOf(chat) } satisfies CoreChatEvent });
    }
  }

  /** Appends one entry to a chat and pushes the change. A closed chat takes the entry for its own
   * turn to finish on, but no surface hears of it. */
  private pushEntry(chat: EngineChat, entry: ChatEntry): void {
    this.spliceEntries(chat, chat.entries.length, 0, [entry]);
  }

  /** Removes `remove` entries of a chat at one index, inserts the given entries there, and pushes
   * the change as one splice. */
  private spliceEntries(chat: EngineChat, index: number, remove: number, entries: readonly CoreChatEntry[]): void {
    chat.entries.splice(index, remove, ...entries);
    chat.revision += 1;
    if (!this.chats.includes(chat)) {
      return;
    }
    this.deps.emit({
      channel: 'chat.event',
      payload: { kind: 'splice', chatId: chat.id, revision: chat.revision, index, remove, entries } satisfies CoreChatEvent,
    });
  }

  /** Finds the chat one runtime id names. */
  private chatById(chatId: number): EngineChat | null {
    return this.chats.find((chat) => chat.id === chatId) ?? null;
  }

  /** Finds the chat one session file id owns. */
  private chatByFileId(fileId: string): EngineChat | null {
    return this.chats.find((chat) => chat.fileId === fileId) ?? null;
  }
}
