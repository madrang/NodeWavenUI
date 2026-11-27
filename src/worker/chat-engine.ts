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
import {
  taskBudgetLimit,
  taskBudgetState,
  taskIsLive,
  taskPlanLines,
  type TaskEvidence,
  type TaskConnection,
  type TaskDispatchMode,
  type TaskEndCause,
  type TaskRecord,
} from '../shared/tasks.js';
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
import { joinSystemPromptTexts, resolveSystemPromptSources, type SystemPromptSource } from '../shared/system-prompts.js';
import { sleep } from '../shared/retry.js';
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
import type { TaskTemplateStore } from './task-templates.js';
import type { EvidenceVerification, TaskToolDeps } from './task-tools.js';

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
  /** The task templates of the worker core, for the create action of the task tool. */
  readonly templates: TaskTemplateStore;
  /** The chat session store of the worker core, which persists every chat. */
  readonly chatSessions: ChatSessionStore;
  /** The settings store of the workspace: the provider registry, the turn limit, and the path rules. */
  readonly settings: WorkspaceSettingsStore;
  /** The storage sharing of the workspace, for the storage reads of the read tool. */
  readonly storageShares: AgentStorageShares;
  /** The registered system prompt sources a first send binds, in menu order. */
  readonly promptSources: readonly SystemPromptSource[];
  /** Lists the prompt files of the instructions folder of the workspace. The engine reads the folder on
   * every bind and on every list, so a file the folder gained or lost shows at once. Absent in a context
   * that reads no workspace folder. */
  readonly listPromptFiles?: () => Promise<readonly SystemPromptSource[]>;
  /** The services of the main process. */
  readonly main: EngineMainCalls;
  /** Builds the inference provider of one account. The specs inject a fake. */
  readonly createProvider: new (config: OpenAiProviderConfig) => InferenceProvider;
  /** The wait before the first retry of a round that failed a task session. The engine default is
   * three seconds. The specs shorten it. */
  readonly taskRetryDelayMs?: number;
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
  /** The wrap-up that waits for the running turn to stop: the wall-clock cap of the task passed
   * mid-turn, and the turn that stops starts the wrap-up itself. */
  wrapupAfterTurn?: TaskWrapup;
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

/** The tools a task session keeps once a limit wraps its task up: it writes its work back and
 * settles the task. */
const TASK_WRITEBACK_TOOLS: readonly string[] = ['tasks', 'write', 'files'];

/** The rounds a wrap-up may spend before the limit ends the task. */
const TASK_WRAPUP_ROUNDS = 3;

/** The wrap-up of one task: the limit that started it, the status it ends with, and the words the
 * session reads. */
interface TaskWrapup {
  readonly status: 'exhausted' | 'timeout';
  readonly cause: TaskEndCause;
  readonly text: string;
}

/** The words of the wrap-up that a budget starts. */
const TASK_BUDGET_WRAPUP =
  '[task budget] The token or turn budget of this task ran low. Run no more commands. Write back the work you have not ' +
  'persisted yet: propose your patches with the write tool, then call the tasks tool with action complete (id, result, ' +
  'evidence), or action fail (id, reason). An answer in plain text ends the task as exhausted.';

/** The words of the wrap-up that the wall clock starts. */
const TASK_TIMEOUT_WRAPUP =
  '[task timeout] The time limit of this task passed. Run no more commands. Write back the work you have not ' +
  'persisted yet: propose your patches with the write tool, then call the tasks tool with action complete (id, result, ' +
  'evidence), or action fail (id, reason). An answer in plain text ends the task as timeout.';

/** The wrap-up the wall clock starts. */
const TIMEOUT_WRAPUP: TaskWrapup = { status: 'timeout', cause: 'timeout', text: TASK_TIMEOUT_WRAPUP };

/** The wrap-up that the budget of one record starts: the record sits at its reserve, or past it. */
function budgetWrapupOf(task: TaskRecord): TaskWrapup {
  return { status: 'exhausted', cause: taskBudgetLimit(task) ?? 'token-budget', text: TASK_BUDGET_WRAPUP };
}

/** The retries a task session spends on a round its provider failed, when its record names no count. */
const TASK_RETRIES_DEFAULT = 2;

/** The wait before the first retry of a failed round. Each further retry waits twice as long. */
const TASK_RETRY_DELAY_MS = 3000;

/** The recovery of a task session after its provider failed a round. */
interface ProviderRecovery {
  /** The wait before the next turn starts. */
  readonly delayMs: number;
  /** The connection the chat moves to before the next turn. Null keeps the bound connection. */
  readonly connection: TaskConnection | null;
  /** True when no retry and no connection remain: the task fails by its provider. */
  readonly exhausted: boolean;
  /** The message of the failure, for the record. */
  readonly message: string;
}

/** The retries and the chain of one running record whose provider failed a round. */
interface RetryState {
  attempts: number;
  /** The place of the next connection in the chain. */
  chain: number;
  /** The connections to try when the retries on one connection run out: the list of the record, or
   * the other accounts of the registry. The list is built once, from the connection the chat held at
   * the first failure of its rounds. */
  readonly connections: readonly TaskConnection[];
}

/** The most characters the read action of the task tool answers for one transcript. The latest part
 * of a longer transcript stays. */
const TRANSCRIPT_CAP = 12_000;

/** Reads the command of one run call argument text. Empty when the text carries none. */
function runCommandOf(arguments_: string): string {
  try {
    const parsed: unknown = JSON.parse(arguments_);
    const command = (parsed as { command?: unknown } | null)?.command;
    return typeof command === 'string' ? command : '';
  } catch {
    return '';
  }
}

/** True when the tool entry of one `run` call answers a command that exited with code zero. The
 * first line of the result names the exit code. */
function commandPassed(content: string): boolean {
  return content === 'exit code: 0' || content.startsWith('exit code: 0\n');
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
  /** The wall-clock timers of the running records that carry a cap, keyed by task id. */
  private readonly taskTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The retries and the chain position of each running record whose provider failed a round. A
   * round that succeeds clears the entry. */
  private readonly taskRetries = new Map<string, RetryState>();
  /** The chats whose tool calls run, innermost last. A tool call of a session can settle the task
   * of that session, and the settle listeners read the stack to tell that session from another. */
  private readonly toolCallChats: number[] = [];

  constructor(deps: ChatEngineDeps) {
    this.deps = deps;
  }

  /** Restores the stored sessions as chats in creation order, and re-links the runtime chat ids of
   * the bound task records: the persisted session files keep their binding, the numeric chat ids
   * start fresh, and each restored chat takes back the task its session runs. A live record whose
   * session file never came back keeps its stale id and shows on the board for a re-dispatch. Call
   * once at boot, before any surface lists the chats. */
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
    // A restored chat takes back the task its session runs: the live record bound to its file, or
    // the last one dispatched there. The turn that follows it pumps and nudges like before the restart.
    const bound = this.deps.tasks.list();
    for (const chat of this.chats) {
      const owned = bound
        .filter((task) => task.sessionFileId === chat.fileId)
        .sort((left, right) => (left.dispatchedAt ?? '').localeCompare(right.dispatchedAt ?? ''));
      const current = owned.find((task) => taskIsLive(task.status)) ?? owned.at(-1) ?? null;
      if (current) {
        chat.taskId = current.id;
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
      // A blocked task cancels too: its session is gone, so no answer can reach it.
      const live = task && (task.status === 'running' || task.status === 'queued' || task.status === 'blocked');
      if (live && task.sessionFileId === chat.fileId) {
        void this.deps.tasks.cancel(task.id, 'The session tab closed.', 'session-closed');
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
    // A session that waits on its own question takes the message as the answer to it.
    const parked = chat.taskId ? this.deps.tasks.get(chat.taskId) : null;
    if (parked?.status === 'blocked' && (call.text.trim().length > 0 || call.images.length > 0)) {
      await this.answerTask(parked.id, call.text.trim(), call.images);
      return true;
    }
    // A record that waits in the queue for a slot holds its messages with the answer, and they deliver when a slot takes it.
    if (this.isRunning(chat.id) || parked?.status === 'queued') {
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
    // A session that waits on its own question takes the message as the answer to it.
    const parked = chat.taskId ? this.deps.tasks.get(chat.taskId) : null;
    if (parked?.status === 'blocked' && text.trim().length > 0) {
      this.unattended(`the answer of task ${parked.id}`, this.answerTask(parked.id, text.trim()));
      return;
    }
    if (this.isRunning(chat.id) || parked?.status === 'queued') {
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

  /** Lands one send-now of the phone: the chat of the named session file sends its queued entry at
   * the index at once, the way the button of the page does. An unknown session file sends nothing. */
  remoteSendNow(fileId: string, index: number): Promise<void> {
    const chat = this.chatByFileId(fileId);
    return chat ? this.sendNow(chat.id, index) : Promise.resolve();
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
      if (!(await this.bindChatSystemPrompt(chat, call.systemPromptIds))) {
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

  /** Lists the system prompt sources a first send binds, in menu order: the list the phone page offers. */
  async promptSources(): Promise<readonly CoreSystemPromptSourceInfo[]> {
    const sources = await this.promptSourceList();
    return sources.map(({ id, label }) => ({ id, label }));
  }

  /** Lists every system prompt source a first send binds, in menu order: the registered sources, then
   * the prompt files of the instructions folder, read fresh. */
  private async promptSourceList(): Promise<readonly SystemPromptSource[]> {
    return [...this.deps.promptSources, ...((await this.deps.listPromptFiles?.()) ?? [])];
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
    // The claim comes before the first await. The cap check and the store writes yield, and a
    // second caller that wakes then, the queue pump for example, must see the task taken.
    this.taskDispatching.add(id);
    try {
      if (!(await this.hasTaskRoom())) {
        // The cap of the workspace is reached. The settle of a running record pumps the queue again.
        return 'The task stays queued: the workspace caps its parallel task sessions, and as many run now. One of them settles, and the queue pumps again.';
      }
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
      // The picks of the origin chat ride along: a session the dispatch opens binds its prompt
      // sources and its connection the way a first send with those picks does.
      const picks = this.inheritedPicks(task);
      if (!(await this.handTaskOver(chat, task, picks?.systemPromptIds))) {
        // A prompt source that failed to build fails the record, and its note names the cause.
        const failed = store.get(task.id);
        return failed?.status === 'failed' ?
          `The task ${id} failed before its session started: ${failed.note}` :
          `The task ${id} left the queued state before its session took it.`;
      }
      // A record that returns to its chat after a question can hold messages there. The held answer
      // starts the turn, so the session reads it before it works.
      await this.drainQueued(chat);
      if (this.isRunning(chat.id)) {
        return outcome;
      }
      if (waitsForTurn) {
        await this.runChatTurn(chat, undefined, picks);
      } else {
        this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat, undefined, picks));
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
    // The return starts a new running stretch, so the wall-clock cap starts again.
    this.armTaskTimeout(returned);
    this.unattended(
      `the return of task ${id}`,
      this.deliverTaskNotice(
        chat,
        `[task ${id}] The user returned the task with a comment:${comment ? `\n${comment}` : ''}\nAddress the comment, then call the tasks tool with action complete again.`,
      ),
    );
  }

  /**
   * Returns one record that failed, or ended by a limit, and the children it failed to the queue,
   * on the session the caller names. The record reopens first, so the retry starts with a full
   * budget, a fresh clock, and an open checklist. Each child keeps the dispatch it had and waits on
   * the record again. A child of a session that closed returns to draft, because that session can
   * no longer take it. The queue pump starts the record when a slot of the workspace frees.
   *
   * @param id The record id.
   * @param mode How the retry binds the session of the record.
   * @param sessionFileId The chat session file, on session mode.
   * @returns The outcome text the board or the agent reads.
   */
  async retryTask(id: string, mode: TaskDispatchMode, sessionFileId: string | null): Promise<string> {
    const store = this.deps.tasks;
    const task = store.get(id);
    if (!task) {
      return 'The task does not exist.';
    }
    if (task.status !== 'failed' && task.status !== 'exhausted' && task.status !== 'timeout') {
      return `The task holds state ${task.status}. Only a task that failed, or ended by a limit, retries.`;
    }
    const bound = mode === 'session' ? this.chatByFileId(sessionFileId ?? '') : null;
    if (mode === 'session' && !bound) {
      // The retry would leave the record queued on a session that can never take it.
      return `The chat session ${sessionFileId ?? '(none)'} holds no open tab. The task stays failed.`;
    }
    // The children that failed through this record return with it, the grandchildren included. The
    // loop visits each entry it appends, so the walk reaches the end of the line.
    const failed = store.list().filter((record) => record.status === 'failed' && record.endCause === 'cascade');
    const line: TaskRecord[] = [task];
    for (const current of line) {
      for (const child of failed) {
        if (child.blockedBy.includes(current.id) && !line.includes(child)) {
          line.push(child);
        }
      }
    }
    const reopened = await store.reopen(task.id);
    const queued = reopened ? await store.dispatch(task.id, mode, sessionFileId) : null;
    if (!queued) {
      return `The task ${id} left the failed state before its retry.`;
    }
    let requeued = 0;
    let drafted = 0;
    for (const child of line.slice(1)) {
      await store.reopen(child.id);
      // A child keeps the dispatch it had. Its session must still be open to take it.
      const open =
        child.dispatchMode === 'new-session' || Boolean(child.sessionFileId && this.chatByFileId(child.sessionFileId));
      const back =
        child.dispatchMode && open ? await store.dispatch(child.id, child.dispatchMode, child.sessionFileId) : null;
      if (back) {
        requeued += 1;
      } else {
        drafted += 1;
      }
    }
    this.pumpTasks();
    const target = mode === 'session' ? `the session "${bound?.title ?? sessionFileId}"` : 'a new session';
    const returns = (count: number, where: string, why: string): string =>
      ` ${count} failed ${count === 1 ? 'child returns' : 'children return'} to ${where}${why}.`;
    return (
      `The task ${id} returns to the queue on ${target}.` +
      (requeued > 0 ? returns(requeued, 'the queue', ' with it') : '') +
      (drafted > 0 ? returns(drafted, 'draft', `, because the ${drafted === 1 ? 'session that ran it' : 'sessions that ran them'} closed`) : '')
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
    } else if (task.status === 'exhausted') {
      head = `The session ran task ${task.id} out of its ${task.endCause === 'turn-budget' ? 'turn' : 'token'} budget.`;
    } else if (task.status === 'timeout') {
      head = `Task ${task.id} ended: its time limit passed.`;
    } else if (task.status === 'blocked') {
      // The question of the session reaches the origin chat, so a parent answers or waits.
      head = `The session asks about task ${task.id}: ${task.question ?? ''}\nAnswer with the tasks tool, action send (id, message), or on the task board.`;
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

  /** Handles one record settle for the chats of the engine: the wall-clock timer of the record
   * ends, a cancel from outside stops the turn of its session, and the origin chat that did not
   * cause the settle hears the outcome. A block counts: its question reaches the origin chat. */
  handleTaskSettle(task: TaskRecord): void {
    this.clearTaskTimeout(task.id);
    this.stopCancelledTask(task);
    this.deliverTaskSettle(task);
  }

  /** Answers the question of a blocked task. The record runs again with the clock it had, the
   * answer lands in its session as the next message, and the turn starts on its own. A task that
   * is not blocked takes the text as a plain send. When the workspace has no slot for the record,
   * the record returns to the queue with the answer held in its session, and the pump dispatches
   * it when a slot frees. */
  async answerTask(id: string, answer: string, images: readonly ChatImage[] = []): Promise<string> {
    const task = this.deps.tasks.get(id);
    if (!task || task.status !== 'blocked') {
      return this.sendTask(id, answer);
    }
    const chat = this.chatOfTask(task);
    if (!chat) {
      return 'The task holds no open session tab.';
    }
    const entry = {
      role: 'user' as const,
      content: `[task ${id}] The operator answered: ${answer}`,
      ...(images.length > 0 ? { images } : {}),
    };
    if (!(await this.hasTaskRoom())) {
      // The workspace caps its parallel task sessions, and as many run now. The record waits in
      // the queue, and the dispatch that takes it delivers the held answer first.
      if (!(await this.deps.tasks.requeue(id))) {
        return `The task ${id} left the blocked state before the answer landed.`;
      }
      this.pushEntry(chat, { ...entry, queued: true });
      this.persistChat(chat);
      return 'The answer entered the session. The task waits in the queue for a free slot of the workspace, and runs then.';
    }
    const resumed = await this.deps.tasks.unblock(id);
    if (!resumed) {
      return `The task ${id} left the blocked state before the answer landed.`;
    }
    this.armTaskTimeout(resumed);
    this.taskNudges.delete(id);
    // A turn that still runs takes the answer as a queued entry, and it delivers when that turn
    // ends. A closing reply would otherwise swallow the answer, because its request went out first.
    const busy = this.isRunning(chat.id);
    this.pushEntry(chat, busy ? { ...entry, queued: true } : entry);
    this.persistChat(chat);
    if (!busy) {
      this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat));
      return 'The answer entered the session, and the task runs again.';
    }
    return 'The answer queued behind the turn of the session, and it delivers when that turn ends.';
  }

  /** Handles the session side of a cancel: the running turn of the session stops when the cancel
   * came from outside, so the agent spends nothing on a dead task, and the session reads why. A
   * session that cancels its own task keeps its turn: the tool result and the entry end it, and an
   * abort would only add a stop notice. Any other settle returns at once. */
  private stopCancelledTask(task: TaskRecord): void {
    if (task.status !== 'cancelled') {
      return;
    }
    const chat = this.chatOfTask(task);
    if (!chat) {
      return;
    }
    if (this.toolCallChats.at(-1) !== chat.id) {
      this.runningTurns.get(chat.id)?.abort();
    }
    // The entry is user text, so the next request of the chat carries the cancel to the model.
    this.pushEntry(chat, {
      role: 'user',
      content:
        `[task ${task.id}] The task was cancelled${task.note ? `: ${task.note}` : '.'}\n` +
        'It needs no more work: do not call the tasks tool for it again.',
    });
    this.persistChat(chat);
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
      // The first send binds the prompt sources and snapshots their text, so the chat keeps what it sent.
      const failure = await this.bindChatSystemPrompt(chat, picks?.systemPromptIds);
      if (failure) {
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

  /** Binds the system prompt of a chat that sits before its first message: the sources the menu holds
   * build one text each, joined in the order of the menu, and the chat snapshots that text, so the chat
   * keeps what it sent. A chat that picks no source binds the none prompt.
   *
   * @param chat The chat that sends its first message.
   * @param picked The source ids the menu holds, or undefined for the default of the workspace.
   * @returns Null when the chat holds a prompt. Else the text of the failure, which also landed as
   * an error entry.
   */
  private async bindChatSystemPrompt(chat: EngineChat, picked?: readonly string[]): Promise<string | null> {
    const sources = resolveSystemPromptSources(picked, await this.promptSourceList());
    const bound: { readonly id: string; readonly label: string; readonly text: string }[] = [];
    for (const source of sources) {
      let text: string;
      try {
        text = await source.build({ workspacePath: this.deps.workspacePath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = `The system prompt source "${source.label}" failed: ${message}`;
        this.pushEntry(chat, { role: 'error', content: failure });
        return failure;
      }
      bound.push({ id: source.id, label: source.label, text });
    }
    chat.boundSystemPrompt = {
      sourceIds: bound.map((part) => part.id),
      title: bound.length > 0 ? bound.map((part) => part.label).join(' + ') : 'No system prompt',
      text: joinSystemPromptTexts(bound.map((part) => part.text)),
    };
    this.metaChanged(chat);
    return null;
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
   * @param wrapup The wrap-up the turn runs, when a limit started one.
   */
  private async runChatTurn(
    chat: EngineChat,
    preloaded?: TurnSettings,
    picks?: CoreChatPicks,
    wrapup?: TaskWrapup,
  ): Promise<void> {
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
    let recovery: ProviderRecovery | null = null;
    try {
      await this.runAgentTurn(
        chat,
        provider,
        connection.model,
        connection.vision,
        settings,
        chat.thinkingLevel ?? settings.thinkingDefault ?? undefined,
        abort.signal,
        wrapup,
      );
    } catch (error) {
      if (abort.signal.aborted) {
        stopped = true;
        // The aborted streaming slot keeps whatever streamed. An empty one drops, queued entries included in the search.
        for (let index = chat.entries.length - 1; index >= 0; index--) {
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
        const message = error instanceof Error ? error.message : String(error);
        this.pushEntry(chat, { role: 'error', content: message });
        // A chat that runs a task recovers on its own: a plain chat waits for its user.
        recovery = this.planProviderRecovery(chat, settings.registry, message);
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
    // The stop a wall-clock cap asked for is the exception: the turn starts the wrap-up itself.
    if (stopped) {
      const wrapupAfter = chat.wrapupAfterTurn;
      delete chat.wrapupAfterTurn;
      if (wrapupAfter && chat.taskId && this.deps.tasks.get(chat.taskId)?.status === 'running') {
        this.unattended(`the wrap-up of task ${chat.taskId}`, this.runChatTurn(chat, settings, undefined, wrapupAfter));
      }
      return;
    }
    if (recovery) {
      this.unattended(`the recovery of task ${chat.taskId}`, this.recoverFromProviderError(chat, recovery));
      return;
    }
    // A question of the session parks the task, and an answer that waits for a slot parks it in
    // the queue. A queued message waits with it: the dispatch that takes the record delivers the
    // held messages first.
    const status = this.deps.tasks.get(chat.taskId ?? '')?.status;
    if (status !== 'blocked' && status !== 'queued') {
      await this.drainQueued(chat);
    }
    await this.afterTaskTurn(chat);
  }

  /** Plans the recovery of a task session after its provider failed a round. The retries of the
   * record come first, each on the same connection. Then the fallback chain moves the chat to its
   * next connection: the list of the record, or the other accounts of the registry with their
   * default models. The chain is built once and walked in order, and each of its connections takes
   * the retries of the record. Null when the chat runs no task that still runs.
   */
  private planProviderRecovery(chat: EngineChat, registry: ProviderRegistry, message: string): ProviderRecovery | null {
    const task = chat.taskId ? this.deps.tasks.get(chat.taskId) : null;
    if (!task || task.status !== 'running') {
      return null;
    }
    const state: RetryState = this.taskRetries.get(task.id) ?? {
      attempts: 0,
      chain: 0,
      // The chain of the record, or the other accounts of the registry with their default models.
      connections:
        task.fallbacks.length > 0 ?
          task.fallbacks :
          registry.accounts
            .filter((account) => account.id !== chat.boundProviderId)
            .map((account) => ({
              providerId: account.id,
              model: effectiveDefaultModel(registry, account) ?? account.models[0]?.id ?? '',
            })),
    };
    if (state.attempts < (task.retries ?? TASK_RETRIES_DEFAULT)) {
      state.attempts += 1;
      this.taskRetries.set(task.id, state);
      return {
        delayMs: (this.deps.taskRetryDelayMs ?? TASK_RETRY_DELAY_MS) * 2 ** (state.attempts - 1),
        connection: null,
        exhausted: false,
        message,
      };
    }
    // The chain is walked once, in order. Each connection takes the retries of the record before the next one.
    while (state.chain < state.connections.length) {
      const next = state.connections[state.chain];
      state.chain += 1;
      // A connection that names no account or no model of the registry can never run.
      const known =
        next &&
        registry.accounts.some(
          (account) => account.id === next.providerId && account.models.some((model) => model.id === next.model),
        );
      if (known) {
        state.attempts = 0;
        this.taskRetries.set(task.id, state);
        return { delayMs: 0, connection: next, exhausted: false, message };
      }
    }
    this.taskRetries.delete(task.id);
    return { delayMs: 0, connection: null, exhausted: true, message };
  }

  /** Runs the recovery of a task session after its provider failed a round: the wait, the move to
   * the next connection, and the new turn. A record with no retry and no connection left fails by
   * its provider. A record that settled while the engine waited recovers nothing. */
  private async recoverFromProviderError(chat: EngineChat, recovery: ProviderRecovery): Promise<void> {
    const task = chat.taskId ? this.deps.tasks.get(chat.taskId) : null;
    if (!task) {
      return;
    }
    if (recovery.exhausted) {
      await this.deps.tasks.fail(
        task.id,
        `The provider failed, and no retry and no fallback remain: ${recovery.message}`,
        'provider',
      );
      return;
    }
    if (recovery.delayMs > 0) {
      await sleep(recovery.delayMs);
    }
    // A turn that started meanwhile, a send of the user for example, carries the task on.
    if (this.deps.tasks.get(task.id)?.status !== 'running' || this.isRunning(chat.id)) {
      return;
    }
    if (recovery.connection) {
      chat.boundProviderId = recovery.connection.providerId;
      chat.boundModel = recovery.connection.model;
      this.pushEntry(chat, {
        role: 'notice',
        content: `The provider failed: ${recovery.message}\nThe task continues on the next connection of its chain, with the model ${recovery.connection.model}.`,
      });
      this.metaChanged(chat);
    }
    await this.runChatTurn(chat);
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

  /** Resumes the task records after a restart. The turn of a running record died with the previous
   * app run, so its session reads one restart notice and takes the task up again. The queue pump
   * then hands the queued records over. Call once after `restore`, before any surface sends. */
  recoverTasks(): void {
    this.unattended('the task recovery', this.resumeInterruptedTasks());
  }

  /** Sends the restart notice to every running record whose session came back, then pumps the queue.
   * The turns start on their own, so one long task holds no other back. */
  private async resumeInterruptedTasks(): Promise<void> {
    for (const task of this.deps.tasks.list()) {
      if (task.status !== 'running') {
        continue;
      }
      const chat = this.chatOfTask(task);
      if (!chat || this.isRunning(chat.id)) {
        continue;
      }
      // A record whose wall-clock cap passed while the app was down goes straight to its wrap-up.
      if (this.taskTimeLeft(task) <= 0) {
        this.unattended(`the wrap-up of task ${task.id}`, this.runChatTurn(chat, undefined, undefined, TIMEOUT_WRAPUP));
        continue;
      }
      this.armTaskTimeout(task);
      // The notice stands as the one nudge of this running stretch: a silent answer hears no second one.
      this.taskNudges.set(task.id, 1);
      this.pushEntry(chat, {
        role: 'user',
        content:
          `[task ${task.id}] The app restarted while the task ran. Continue the task from the session history, then call the tasks tool ` +
          'with action complete (id, result, evidence), or action fail (id, reason).',
      });
      this.persistChat(chat);
      this.unattended(`the turn of chat ${chat.id}`, this.runChatTurn(chat));
    }
    await this.pumpQueuedTasks();
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
      templates: this.deps.templates,
      dispatch: (id, mode, sessionFileId) => this.dispatch(id, mode, sessionFileId),
      retry: (id, mode, sessionFileId) => this.retryTask(id, mode, sessionFileId),
      send: (id, message) => this.sendTask(id, message),
      verifyEvidence: (task, evidence) => this.verifyTaskEvidence(task, evidence),
      readEntries: (task) => this.taskTranscript(task),
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

  /** Builds the brief entry one session reads when it takes a task. The plan and the checklist of
   * the record ride along when its creator wrote them. A checklist changes the closing words: the
   * session proves each goal before it completes the task. */
  private taskBrief(task: TaskRecord): string {
    const rows = [`[task ${task.id}] ${task.title}`];
    if (task.description) {
      rows.push(task.description);
    }
    if (task.goal) {
      rows.push(`Goal: ${task.goal}`);
    }
    if (task.plan.length > 0) {
      rows.push(`Plan:\n${taskPlanLines(task).join('\n')}`);
    }
    if (task.goals.length > 0) {
      rows.push(`Goals to prove:\n${task.goals.map((goal, index) => `  ${index + 1}. ${goal.text}`).join('\n')}`);
    }
    rows.push(
      task.goals.length > 0 ?
        'Work only this task. Prove each goal with the tasks tool, action prove (id, goal, proof): the proof is a list, and each item names a patch this session proposed (kind patch, id) or a command this session ran (kind command, command). ' +
        'When every goal is met, call action complete (id, result, evidence), or action fail (id, reason) when a goal does not hold.' :
        'Work only this task. Verify the goal before you finish, then call the tasks tool with action complete (id, result, evidence), or action fail (id, reason) when it does not hold.',
    );
    return rows.join('\n');
  }

  /** Verifies the evidence of a goal proof against what the session of the task did. A patch holds
   * when the patch store holds that record for the session, and a command holds when the session
   * made a run call with that command and the result of the call names exit code zero. */
  private verifyTaskEvidence(task: TaskRecord, evidence: readonly TaskEvidence[]): EvidenceVerification {
    const verified: TaskEvidence[] = [];
    const refused: string[] = [];
    const chat = this.chatOfTask(task);
    for (const reference of evidence) {
      if (reference.kind === 'patch') {
        const patch = this.deps.patches.patch(reference.id);
        const owned =
          patch &&
          (patch.sessionFileId && task.sessionFileId ?
            patch.sessionFileId === task.sessionFileId :
            patch.chatId === task.sessionChatId);
        if (owned) {
          verified.push(reference);
        } else {
          refused.push(`patch ${reference.id} is no patch the session of the task proposed`);
        }
        continue;
      }
      // The result holds when a run of the command went out in the foreground and exited with code
      // zero. A refused call, a failed command, a timed out one, or a background start proves
      // nothing, so a later passing run of the same command is the one that counts.
      const entries = chat?.entries ?? [];
      const callIds = new Set(
        entries
          .flatMap((entry) => entry.toolCalls ?? [])
          .filter((candidate) => candidate.name === 'run' && runCommandOf(candidate.arguments) === reference.command)
          .map((candidate) => candidate.id),
      );
      const landed = entries.some(
        (entry) => entry.role === 'tool' && callIds.has(entry.toolCallId ?? '') && commandPassed(entry.content),
      );
      if (landed) {
        verified.push(reference);
      } else {
        refused.push(`the session of the task ran no command "${reference.command}" that exited with code zero`);
      }
    }
    return { verified, refused };
  }

  /** Renders the transcript of the session of one task for the read action of the task tool: the
   * requests, the replies, and the tool calls with their results. Null when the session holds no
   * open tab in this app run. A long transcript keeps its latest part under a size cap. */
  private taskTranscript(task: TaskRecord): string | null {
    const chat = this.chatOfTask(task);
    if (!chat) {
      return null;
    }
    const lines: string[] = [];
    for (const entry of chat.entries) {
      if (entry.role === 'user') {
        if (!entry.queued) {
          lines.push(`user: ${entry.content}`);
        }
      } else if (entry.role === 'assistant') {
        if (entry.content) {
          lines.push(`assistant: ${entry.content}`);
        }
        for (const call of entry.toolCalls ?? []) {
          lines.push(`tool call: ${call.name} ${call.arguments}`);
        }
      } else if (entry.role === 'tool') {
        lines.push(`tool result: ${entry.content}`);
      } else if (entry.role === 'error' || entry.role === 'notice') {
        // A failed provider round or a stop explains why a session stalled, so the transcript keeps them.
        lines.push(`${entry.role}: ${entry.content}`);
      }
    }
    const text = lines.join('\n');
    if (text.length <= TRANSCRIPT_CAP) {
      return text;
    }
    return `[the earlier part of the transcript sits out of this read]\n${text.slice(-TRANSCRIPT_CAP)}`;
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
      return this.handTaskOver(chat, queued);
    } finally {
      this.taskDispatching.delete(task.id);
    }
  }

  /** Binds one chat to a task, names its work, and pushes the brief. The turn of the session starts
   * with the dispatch that called this. A session that holds no prompt yet binds the given sources,
   * or the default of the workspace, so the session agent reads the harness prompt and the
   * instructions the way a chat does on its first send.
   *
   * @param chat The chat that takes the task.
   * @param task The queued record.
   * @param systemPromptIds The prompt sources the session inherits. Undefined binds the default.
   * @returns True when the brief landed. False when the record left the queued state first, or when
   * a prompt source failed: then the record fails with the cause, and a notice or error entry
   * explains it.
   */
  private async handTaskOver(
    chat: EngineChat,
    task: TaskRecord,
    systemPromptIds?: readonly string[],
  ): Promise<boolean> {
    chat.taskId = task.id;
    this.metaChanged(chat);
    const bound = await this.deps.tasks.bindSession(task.id, chat.id, chat.fileId);
    if (!bound) {
      // The record left the queued state while the dispatch ran, a cancel for example.
      this.pushEntry(chat, {
        role: 'notice',
        content: `The task ${task.id} left the queue before this chat took it. Nothing was sent.`,
      });
      this.persistChat(chat);
      return false;
    }
    // A session that ran this record before lets go of it here: one record has one session.
    for (const other of this.chats) {
      if (other !== chat && other.taskId === task.id) {
        delete other.taskId;
        this.metaChanged(other);
      }
    }
    this.armTaskTimeout(bound);
    const failure = this.chatNeedsSystemPrompt(chat) ? await this.bindChatSystemPrompt(chat, systemPromptIds) : null;
    if (failure) {
      // The session cannot start without its prompt. The record fails with the cause its entry names,
      // and the queued children it held fail with it.
      await this.deps.tasks.fail(task.id, `The session could not start. ${failure}`, 'session-start');
      return false;
    }
    // The session names its work after the record, so the patches of the run group under the task
    // title and the tab reads it.
    await this.deps.patches.setTask(chat.id, task.title, task.description, false);
    // A session that read the brief of this record reads it once: a record that returns to its chat
    // after a question picks up where it left off.
    const head = `[task ${task.id}] ${task.title}`;
    const briefed = chat.entries.some(
      (entry) => entry.role === 'user' && (entry.content === head || entry.content.startsWith(`${head}\n`)),
    );
    if (!briefed) {
      this.pushEntry(chat, { role: 'user', content: this.taskBrief(task) });
    }
    this.persistChat(chat);
    return true;
  }

  /** The picks a task session inherits: the provider, the model, and the prompt sources of the chat
   * whose agent created the task, when that chat lives in this app run. Undefined means the defaults
   * of the workspace. */
  private inheritedPicks(task: TaskRecord): CoreChatPicks | undefined {
    const origin = task.originChatId ? this.chatById(task.originChatId) : null;
    if (!origin) {
      return undefined;
    }
    return {
      ...(origin.boundProviderId ? { providerId: origin.boundProviderId } : {}),
      ...(origin.boundModel ? { model: origin.boundModel } : {}),
      ...(origin.boundSystemPrompt ? { systemPromptIds: [...origin.boundSystemPrompt.sourceIds] } : {}),
    };
  }

  /** Opens sessions and hands idle chats their next ready queued task. Runs on every record change.
   * The queue order is the priority of the records, and the cap of the workspace on its parallel
   * task sessions holds the rest until a running record settles. */
  private async pumpQueuedTasks(): Promise<void> {
    const store = this.deps.tasks;
    for (const task of store.queued()) {
      if (this.taskDispatching.has(task.id) || !store.ready(task)) {
        continue;
      }
      if (!(await this.hasTaskRoom())) {
        return;
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
      // A turn that runs carries the task on: the drain of this chat may have just started one.
      if (this.isRunning(chat.id)) {
        return;
      }
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

  /** Sends one message into the session of a task. A busy session queues the entry for its drain.
   * A blocked task takes the message as the answer to its question. A record that waits in the
   * queue for a slot holds the message with its answer. */
  private async sendTask(id: string, message: string): Promise<string> {
    const task = this.deps.tasks.get(id);
    if (!task) {
      return 'The task does not exist.';
    }
    if (task.status === 'blocked') {
      return this.answerTask(id, message);
    }
    const chat = this.chatOfTask(task);
    if (!chat) {
      return 'The task holds no open session tab.';
    }
    if (task.status === 'queued') {
      // The record waits for a slot with its answer held in the session: the message waits with it.
      this.pushEntry(chat, { role: 'user', content: `[task ${id}] ${message}`, queued: true });
      this.persistChat(chat);
      return 'The task waits for a free slot of the workspace. The message queued in its session with the answer, and it delivers when a slot takes it.';
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

  /** Runs the tool-calling loop of one user message, until the model answers in text or hits the
   * round limit. The loop charges every round to the task of the chat. A budget that runs low, or a
   * wrap-up the caller passes, narrows the tools to the write-back ones and ends the task by its
   * limit when the agent no longer settles it. A turn that starts while the budget sits at its
   * reserve runs as that wrap-up. A question of the session ends the loop after a closing reply. */
  private async runAgentTurn(
    chat: EngineChat,
    provider: InferenceProvider,
    model: string,
    vision: boolean,
    settings: TurnSettings,
    thinkingLevel: string | undefined,
    signal: AbortSignal,
    forced?: TaskWrapup,
  ): Promise<void> {
    let turn = 0;
    const limit = settings.turnLimit;
    // The wrap-up of the task of the chat: a limit started it, or its budget already sits at the reserve.
    let wrapup: TaskWrapup | null = forced ?? this.pendingWrapup(chat);
    let wrapupRounds = 0;
    let announced = false;
    while (typeof limit !== 'number' || turn < limit) {
      turn += 1;
      // A round counts as a wrap-up round when its request went out after the wrap-up began.
      const inWrapup = wrapup !== null;
      if (wrapup && !announced) {
        // The words land as user text, so the model reads them in this round and in every later one.
        announced = true;
        this.pushEntry(chat, { role: 'user', content: wrapup.text });
        this.persistChat(chat);
      }
      const tools = await this.agentTools(chat, settings);
      // The messages build before the streaming slot opens, so the slot never reaches the model.
      const messages = this.agentMessages(chat, vision);
      // A question of the session parks the task: the turn may close in text, and it offers no tool while the task waits.
      const parked = this.deps.tasks.get(chat.taskId ?? '')?.status === 'blocked';
      // A wrap-up keeps the write-back tools only, so the session settles the task and nothing else.
      const offered = parked ? [] : wrapup ? tools.filter((tool) => TASK_WRITEBACK_TOOLS.includes(tool.name)) : tools;
      const streaming = this.beginStreamingEntry(chat);
      const result = await provider.complete({
        model,
        messages,
        tools: offered.map(agentToolDefinition),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        onDelta: streaming.onDelta,
        signal,
      });
      if (result.usage) {
        chat.contextTokens = result.usage.promptTokens;
        chat.outputTokens = (chat.outputTokens ?? 0) + result.usage.completionTokens;
        this.metaChanged(chat);
      }
      // A round that came back clears the retries of the task.
      if (chat.taskId) {
        this.taskRetries.delete(chat.taskId);
      }
      const charged = chat.taskId ?
        await this.deps.tasks.charge(
          chat.taskId,
          result.usage?.promptTokens ?? 0,
          result.usage?.completionTokens ?? 0,
        ) :
        null;
      const calls = result.toolCalls ?? [];
      // The caps bind a record that runs. A round of a record in review counts, but it wraps nothing up.
      if (!wrapup && charged && charged.status === 'running' && taskBudgetState(charged) !== 'run') {
        // The budget ran low. The calls of this round that are no write-back refuse, and the next
        // round wraps up.
        wrapup = budgetWrapupOf(charged);
      }
      streaming.settle({
        role: 'assistant',
        content: result.content,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      });
      const refusal = wrapup ? wrapup.text : undefined;
      // The refusals of this round carry the words of the wrap-up, so the next round needs no second copy.
      if (refusal && calls.some((call) => !TASK_WRITEBACK_TOOLS.includes(call.name))) {
        announced = true;
      }
      for (const call of calls) {
        // A parked task holds no tool for the session: a call that comes anyway meets no tool.
        await this.runAgentToolCall(chat, parked ? [] : tools, call, refusal);
      }
      if (parked) {
        return;
      }
      const latest = this.deps.tasks.get(chat.taskId ?? '');
      if (wrapup && inWrapup) {
        wrapupRounds += 1;
        // The agent settled the task, answered in text, or used the rounds of the wrap-up: the limit
        // ends the task that still runs.
        if (
          !latest ||
          latest.status !== 'running' ||
          calls.length === 0 ||
          wrapupRounds >= TASK_WRAPUP_ROUNDS ||
          taskBudgetState(latest) === 'out'
        ) {
          await this.endTaskByLimit(chat, wrapup);
          return;
        }
        continue;
      }
      if (wrapup && latest?.status !== 'running') {
        // The calls of the round that reached the reserve settled the task: no wrap-up follows it.
        return;
      }
      if (calls.length === 0) {
        // The round that reached the reserve ended in plain text. The next round is the wrap-up, so
        // the session reads its words and writes its work back.
        if (wrapup) {
          continue;
        }
        return;
      }
    }
    if (wrapup) {
      // The round limit of the workspace ended the wrap-up first.
      await this.endTaskByLimit(chat, wrapup);
      return;
    }
    this.pushEntry(chat, {
      role: 'error',
      content: `The agent exceeded ${limit} tool rounds in one message.`,
    });
  }

  /** Ends the task of one chat by the limit that wrapped it up. The record settles with the cause
   * of the limit, unless the agent settled it first, and the session reads the end. */
  private async endTaskByLimit(chat: EngineChat, wrapup: TaskWrapup): Promise<void> {
    if (!chat.taskId || !(await this.deps.tasks.endRun(chat.taskId, wrapup.status, wrapup.cause))) {
      return;
    }
    this.pushEntry(chat, {
      role: 'notice',
      content: wrapup.status === 'timeout' ?
        `The task ${chat.taskId} ended as timeout: its time limit passed.` :
        `The task ${chat.taskId} ended as exhausted: its budget ran out.`,
    });
    this.persistChat(chat);
  }

  /** The wrap-up a turn starts in when the budget of the task of the chat already sits at its
   * reserve, or past it. Null while the chat runs no running task, or while its budget runs. */
  private pendingWrapup(chat: EngineChat): TaskWrapup | null {
    const task = chat.taskId ? this.deps.tasks.get(chat.taskId) : null;
    return task && task.status === 'running' && taskBudgetState(task) !== 'run' ? budgetWrapupOf(task) : null;
  }

  /** True when the workspace sets no cap on its task sessions, or when fewer records run than the
   * cap allows. A record counts while its status is running. */
  private async hasTaskRoom(): Promise<boolean> {
    const cap = await this.deps.settings.loadTaskConcurrency();
    if (!cap) {
      return true;
    }
    return this.deps.tasks.list().filter((task) => task.status === 'running').length < cap;
  }

  /** The milliseconds left before the wall-clock cap of one record passes. Infinity without a cap,
   * and infinity before the record started. */
  private taskTimeLeft(task: TaskRecord): number {
    return task.timeoutMs && task.startedAt ? Date.parse(task.startedAt) + task.timeoutMs - Date.now() : Infinity;
  }

  /** Arms the wall-clock cap of one running record: when it passes, the session wraps the task up
   * and the record ends as timeout. A record without a cap, or one that no longer runs, arms nothing. */
  private armTaskTimeout(task: TaskRecord): void {
    this.clearTaskTimeout(task.id);
    const left = this.taskTimeLeft(task);
    if (left === Infinity || task.status !== 'running') {
      return;
    }
    const timer = setTimeout(() => {
      this.taskTimers.delete(task.id);
      this.onTaskTimeout(task.id);
    }, Math.max(0, left));
    // The timer never keeps the process alive on its own.
    timer.unref();
    this.taskTimers.set(task.id, timer);
  }

  /** Ends the wall-clock timer of one record, when one runs. */
  private clearTaskTimeout(id: string): void {
    const timer = this.taskTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.taskTimers.delete(id);
    }
  }

  /** Handles the wall-clock cap of one record when it passes. The turn that runs stops and starts
   * the wrap-up itself, so the two never overlap. A session that sits idle starts the wrap-up at once. */
  private onTaskTimeout(id: string): void {
    const task = this.deps.tasks.get(id);
    const chat = task ? this.chatOfTask(task) : null;
    if (!task || task.status !== 'running' || !chat) {
      return;
    }
    if (this.isRunning(chat.id)) {
      chat.wrapupAfterTurn = TIMEOUT_WRAPUP;
      this.runningTurns.get(chat.id)?.abort();
      return;
    }
    this.unattended(`the wrap-up of task ${id}`, this.runChatTurn(chat, undefined, undefined, TIMEOUT_WRAPUP));
  }

  /** Runs one tool call of the agent and appends the result entry the next request retransmits.
   *
   * @param chat The chat whose turn runs the call.
   * @param tools The tools of the turn.
   * @param call The call of the model.
   * @param refusal The words that answer a call that is no write-back, while a limit wraps the task
   * of the chat up. The call does not run.
   */
  private async runAgentToolCall(
    chat: EngineChat,
    tools: readonly AgentTool[],
    call: ToolCall,
    refusal?: string,
  ): Promise<void> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      args = typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = { _raw: call.arguments };
    }
    let output: AgentToolOutput;
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (refusal && !TASK_WRITEBACK_TOOLS.includes(call.name)) {
      // A limit wrapped the task up: a call that is no write-back refuses, and the model reads why.
      output = { text: refusal };
    } else if (!tool) {
      output = { text: `Error: no tool named "${call.name}" exists.` };
    } else {
      try {
        // The stack names the chat whose tool call runs, so a settle that the call causes tells its
        // own session from another.
        this.toolCallChats.push(chat.id);
        output = await tool.run(args);
      } catch (error) {
        output = { text: `Error: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        this.toolCallChats.pop();
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
    if (system && system.sourceIds.length > 0 && system.text.length > 0) {
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
    return orderToolBatches(messages);
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

/** Puts every tool result right under the tool call it answers. A message that sends now lands
 * after the reply that called the tools and before their results, because the results append after
 * it. A request that carries a user message between a call and its results is refused by strict
 * providers, so the held user messages send after the batch. The entries of the chat keep their
 * order: only the wire moves. */
function orderToolBatches(messages: readonly ChatMessage[]): ChatMessage[] {
  const ordered = [...messages];
  for (let call = 0; call < ordered.length; call++) {
    if (!ordered[call]?.toolCalls?.length) {
      continue;
    }
    let end = call + 1;
    while (end < ordered.length && (ordered[end]?.role === 'tool' || ordered[end]?.role === 'user')) {
      end += 1;
    }
    // The run that follows a tool-call reply holds the results of the batch and the held messages.
    const run = ordered.slice(call + 1, end);
    const firstUser = run.findIndex((message) => message.role === 'user');
    if (firstUser < 0 || !run.slice(firstUser + 1).some((message) => message.role === 'tool')) {
      continue;
    }
    ordered.splice(
      call + 1,
      run.length,
      ...run.filter((message) => message.role === 'tool'),
      ...run.filter((message) => message.role === 'user'),
    );
  }
  return ordered;
}
