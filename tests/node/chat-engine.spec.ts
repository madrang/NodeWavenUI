/**
 * Specs for the chat engine of the worker core: a send runs a turn through the provider and
 * records the reply, the reply streams as deltas, a message queues behind a running turn, a stop
 * ends the turn, a tool call reaches main and its result returns to the model, the first send
 * binds the system prompt, a closed chat stops its turn and leaves no session file, and a new
 * engine restores the stored sessions. A cancel stops the turn of the task session, a dispatch
 * binds a prompt, a restart resumes the records, and a message that sends now follows the tool
 * results of its batch. The provider and the services of the main process are fakes.
 */

import { expect } from 'chai';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine, type ChatEngineDeps, type EngineGate, type EngineMainCalls } from '../../dist/worker/chat-engine.js';
import { ChatSessionStore } from '../../dist/worker/chat-sessions.js';
import { PatchStore } from '../../dist/worker/patch-store.js';
import { TaskStore } from '../../dist/worker/task-store.js';
import { TaskTemplateStore } from '../../dist/worker/task-templates.js';
import { workerPromptFileLister } from '../../dist/worker/system-prompts.js';
import { WorkspaceSettingsStore } from '../../dist/storage/settings-store.js';
import type { StorageBackend } from '../../dist/storage/storage.js';
import type { OpenAiProviderConfig } from '../../dist/providers/openai.js';
import type { CompletionRequest, CompletionResult, InferenceProvider } from '../../dist/providers/provider.js';
import type { CoreChatEvent } from '../../dist/shared/core-api.js';
import type { TaskRecord } from '../../dist/shared/tasks.js';

/** One in-memory settings backend. */
class MemoryBackend implements StorageBackend {
  readonly id = 'memory';
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.values.keys()];
  }
}

/** The answer script of the fake provider: the requests it received, and the answer of the next call. */
interface ProviderScript {
  readonly requests: CompletionRequest[];
  answer(request: CompletionRequest): Promise<CompletionResult>;
}

/** Builds the script of a fake provider that answers from a list, one answer per call. */
function scripted(...answers: readonly CompletionResult[]): ProviderScript {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    answer: async (request) => {
      requests.push(request);
      return answers[Math.min(requests.length, answers.length) - 1] as CompletionResult;
    },
  };
}

/** Reads one text answer of the fake provider. */
function text(content: string): CompletionResult {
  return { content, model: 'test-model' };
}

/** Reads the answer of the fake provider that completes one task through the tasks tool, so the
 * turn of the task ends without a nudge. */
function completion(taskId: string): CompletionResult {
  const arguments_ = JSON.stringify({ action: 'complete', id: taskId, result: 'Sorted.', evidence: 'ls reads sorted' });
  return { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'tasks', arguments: arguments_ }] };
}

/** The script of a fake provider that holds its first request until `release` runs, so a test acts
 * while the turn runs. */
interface HeldScript extends ProviderScript {
  release(): void;
}

/** Builds the script that holds its first request. */
function heldOnce(): HeldScript {
  const requests: CompletionRequest[] = [];
  let release: () => void = () => {};
  return {
    requests,
    release: () => {
      release();
    },
    answer: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return text(`answer ${requests.length}`);
    },
  };
}

/** Builds the script of a fake provider whose request ends when its signal aborts. */
function abortable(): ProviderScript {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    answer: (request) => {
      requests.push(request);
      return new Promise<CompletionResult>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new Error('The request was aborted.'));
        });
      });
    },
  };
}

/** The provider class of the specs: every instance answers through the one script of the test. */
let script: ProviderScript = scripted(text('unused'));

/** The base URL of every provider the engine built, in turn order. It names the account of each turn. */
const providerAccounts: string[] = [];

class FakeProvider implements InferenceProvider {
  readonly id = 'fake';

  constructor(config: OpenAiProviderConfig) {
    providerAccounts.push(config.baseUrl);
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return script.answer(request);
  }
}

/** The chat events the engine pushed, in order. */
const events: CoreChatEvent[] = [];

/** The window and command tool calls the engine sent to the fake main process. */
const windowCalls: { name: string; args: Record<string, unknown>; source: string }[] = [];

/** The gate of the specs: every check passes, and no rule governs a tool. */
const gate: EngineGate = {
  check: async () => {},
  listRules: () => [],
};

/** The services of the main process, as fakes that record the window tool calls. */
const main: EngineMainCalls = {
  runWindowTool: async (name, args, source) => {
    windowCalls.push({ name, args, source });
    return { content: [{ type: 'text', text: `ran ${name}` }] };
  },
  readResource: async () => '',
  nativeTools: async () => [],
  runNativeTool: async () => ({ isError: false, text: '', images: [] }),
};

/** The one provider account of the specs: a text-only model. */
const ACCOUNT = {
  id: 'account-1',
  label: 'Spec account',
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'key',
  models: [{ id: 'test-model', vision: false }],
};

/** Yields to the event loop until one condition holds, or the budget runs out. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  expect(condition(), 'the condition never held').to.equal(true);
}

/** Waits on the wall clock until one condition holds, or the budget runs out. The specs that depend
 * on a timer use it, because a timer needs real time and not event-loop ticks. */
async function waitForMs(condition: () => boolean, budgetMs = 1500): Promise<void> {
  const until = Date.now() + budgetMs;
  while (!condition() && Date.now() < until) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  expect(condition(), 'the condition never held').to.equal(true);
}

describe('the chat engine', () => {
  let root: string;
  let backend: MemoryBackend;
  let engine: ChatEngine;

  /** Builds one engine over the stores of the spec workspace. */
  async function open(overrides: Partial<ChatEngineDeps> = {}): Promise<ChatEngine> {
    const settings = new WorkspaceSettingsStore(backend);
    const patches = new PatchStore(root);
    await patches.load();
    const tasks = new TaskStore(root);
    await tasks.load();
    const templates = new TaskTemplateStore(root);
    await templates.load();
    const chatSessions = new ChatSessionStore(root, settings, false);
    const deps: ChatEngineDeps = {
      workspacePath: root,
      gate,
      patches,
      tasks,
      templates,
      chatSessions,
      settings,
      storageShares: { readKey: async () => null },
      promptSources: [],
      main,
      createProvider: FakeProvider,
      emit: (event) => {
        events.push(event.payload as CoreChatEvent);
      },
      ...overrides,
    };
    return new ChatEngine(deps);
  }

  /** Sends one text message and waits until the turn of the chat ended. */
  async function turn(textToSend: string): Promise<number> {
    const chat = engine.create();
    expect(await engine.send({ chatId: chat.id, text: textToSend, images: [] })).to.equal(true);
    await waitFor(() => !engine.isRunning(chat.id));
    return chat.id;
  }

  /** Opens the task store of the spec workspace. */
  async function taskStore(): Promise<TaskStore> {
    const tasks = new TaskStore(root);
    await tasks.load();
    return tasks;
  }

  /** Creates one draft task, and fails the spec when the store refuses it. */
  async function createTask(tasks: TaskStore, blockedBy: readonly string[] = []): Promise<TaskRecord> {
    const task = await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy,
    });
    if (!task) {
      throw new Error('The task store refused the draft task of the spec.');
    }
    return task;
  }

  /** Waits until one task completed into review and the turn of its chat ended. */
  async function settleTask(tasks: TaskStore, taskId: string, chatId: number): Promise<void> {
    await waitFor(() => tasks.get(taskId)?.status === 'review' && !engine.isRunning(chatId));
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nvengine-'));
    events.length = 0;
    windowCalls.length = 0;
    providerAccounts.length = 0;
    script = scripted(text('unused'));
    backend = new MemoryBackend();
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [ACCOUNT],
      defaultProviderId: ACCOUNT.id,
      defaultModel: 'test-model',
    });
    engine = await open();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('delivers a message, records the reply, and persists the session', async () => {
    script = scripted(text('the reply'));
    const chatId = await turn('hello');
    const chat = engine.get(chatId);
    expect(chat?.entries.map((entry) => entry.role)).to.deep.equal(['user', 'assistant']);
    expect(chat?.entries[1]?.content).to.equal('the reply');
    expect(chat?.boundProviderId).to.equal(ACCOUNT.id);
    expect(chat?.boundModel).to.equal('test-model');
    expect(chat?.running).to.equal(false);
    // The session file lands under the workspace `chats/` folder, named after the session id.
    await waitFor(() => existsSync(join(root, 'chats', `${chat?.fileId ?? ''}.json`)));
  });

  it('pushes the state of the turn and the reply as deltas', async () => {
    script = {
      requests: [],
      answer: async (request) => {
        request.onDelta?.({ content: 'the ' });
        request.onDelta?.({ content: 'reply' });
        return text('the reply');
      },
    };
    const chatId = await turn('hello');
    const metas = events.filter((event) => event.kind === 'meta' && event.chat.id === chatId);
    expect(metas.length).to.be.greaterThan(1);
    const deltas = events.flatMap((event) => (event.kind === 'delta' ? [event] : []));
    expect(deltas.map((delta) => delta.content)).to.deep.equal(['the ', 'reply']);
    expect(deltas.every((delta) => delta.chatId === chatId && delta.index === 1)).to.equal(true);
    // Every pushed change carries the revision of the chat, and the revisions never repeat.
    const revisions = events.flatMap((event) =>
      event.kind === 'splice' ? [event.revision] : event.kind === 'meta' ? [event.chat.revision] : [],
    );
    expect(new Set(revisions).size).to.equal(revisions.length);
  });

  it('queues a message behind a running turn and delivers it when the turn ends', async () => {
    const held = heldOnce();
    script = held;
    const chat = engine.create();
    await engine.send({ chatId: chat.id, text: 'first', images: [] });
    await waitFor(() => held.requests.length === 1);
    expect(await engine.send({ chatId: chat.id, text: 'second', images: [] })).to.equal(true);
    expect(engine.get(chat.id)?.entries.map((entry) => entry.role)).to.deep.equal(['user', 'assistant', 'user']);
    held.release();
    await waitFor(() => !engine.isRunning(chat.id));
    expect(held.requests.length).to.equal(2);
    // The queued entry reaches the model only with the turn that delivers it.
    expect(held.requests[1]?.messages.map((message) => message.role)).to.deep.equal(['user', 'assistant', 'user']);
    expect(engine.get(chat.id)?.entries.map((entry) => entry.content)).to.deep.equal(['first', 'answer 1', 'second', 'answer 2']);
  });

  it('stops a running turn and keeps the messages', async () => {
    script = abortable();
    const chat = engine.create();
    await engine.send({ chatId: chat.id, text: 'hello', images: [] });
    await waitFor(() => script.requests.length === 1);
    engine.stop(chat.id);
    await waitFor(() => !engine.isRunning(chat.id));
    // The empty streaming slot drops, and the notice closes the chat.
    expect(engine.get(chat.id)?.entries.map((entry) => `${entry.role}:${entry.content}`)).to.deep.equal(['user:hello', 'notice:Stopped.']);
  });

  it('refuses images for a text-only model and leaves the message out', async () => {
    const chat = engine.create();
    const accepted = await engine.send({ chatId: chat.id, text: 'look', images: [{ data: 'AAAA', mimeType: 'image/png' }] });
    expect(accepted).to.equal(false);
    expect(script.requests).to.have.lengthOf(0);
    expect(engine.get(chat.id)?.entries.map((entry) => entry.role)).to.deep.equal(['notice']);
  });

  it('runs a tool call in main and returns its result to the model', async () => {
    script = scripted(
      { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'list_pages', arguments: '{}' }] },
      text('done'),
    );
    const chatId = await turn('list the pages');
    expect(windowCalls).to.deep.equal([{ name: 'list_pages', args: {}, source: `chat-agent:${chatId}` }]);
    const chat = engine.get(chatId);
    expect(chat?.entries.map((entry) => entry.role)).to.deep.equal(['user', 'assistant', 'tool', 'assistant']);
    expect(chat?.entries[2]).to.include({ role: 'tool', content: 'ran list_pages', toolCallId: 'call-1', toolName: 'list_pages' });
    // The second request retransmits the tool call and its result.
    expect(script.requests.length).to.equal(2);
    expect(script.requests[1]?.messages.map((message) => message.role)).to.deep.equal(['user', 'assistant', 'tool']);
  });

  it('binds the system prompt of the first send and sends it first', async () => {
    engine = await open({
      promptSources: [{ id: 'agents-md', label: 'AGENTS.md', build: async () => 'Be terse.' }],
    });
    await turn('hello');
    expect(script.requests[0]?.messages[0]).to.deep.equal({ role: 'system', content: 'Be terse.' });
    expect(engine.list()[0]?.systemPrompt).to.deep.equal({ sourceIds: ['agents-md'], title: 'AGENTS.md', text: 'Be terse.' });
  });

  it('binds several sources in the order of the pick and joins their texts', async () => {
    engine = await open({
      promptSources: [
        { id: 'rules', label: 'Rules', build: async () => 'Be terse.\n\n' },
        { id: 'skills', label: 'Skills', build: async () => 'Use the read tool.' },
      ],
    });
    const chat = engine.create();
    const picks = { systemPromptIds: ['skills', 'rules'] };
    expect(await engine.send({ chatId: chat.id, text: 'hello', images: [], ...picks })).to.equal(true);
    await waitFor(() => !engine.isRunning(chat.id));
    expect(script.requests[0]?.messages[0]).to.deep.equal({ role: 'system', content: 'Use the read tool.\n\nBe terse.' });
    expect(engine.get(chat.id)?.systemPrompt).to.deep.equal({
      sourceIds: ['skills', 'rules'],
      title: 'Skills + Rules',
      text: 'Use the read tool.\n\nBe terse.',
    });
  });

  it('binds the none prompt for an empty pick', async () => {
    engine = await open({ promptSources: [{ id: 'rules', label: 'Rules', build: async () => 'Be terse.' }] });
    const chat = engine.create();
    expect(await engine.send({ chatId: chat.id, text: 'hello', images: [], systemPromptIds: [] })).to.equal(true);
    await waitFor(() => !engine.isRunning(chat.id));
    // The request carries no system message.
    expect(script.requests[0]?.messages[0]?.role).to.equal('user');
    expect(engine.get(chat.id)?.systemPrompt).to.deep.equal({ sourceIds: [], title: 'No system prompt', text: '' });
  });

  it('lists the prompt files of the instructions folder fresh, and binds one', async () => {
    engine = await open({ listPromptFiles: workerPromptFileLister(root) });
    expect(await engine.promptSources()).to.deep.equal([]);
    mkdirSync(join(root, 'instructions'));
    writeFileSync(join(root, 'instructions', 'rules.md'), 'Be terse.');
    expect(await engine.promptSources()).to.deep.equal([{ id: 'prompt-file:rules.md', label: 'rules.md' }]);
    const chat = engine.create();
    const picks = { systemPromptIds: ['prompt-file:rules.md'] };
    expect(await engine.send({ chatId: chat.id, text: 'hello', images: [], ...picks })).to.equal(true);
    await waitFor(() => !engine.isRunning(chat.id));
    expect(engine.get(chat.id)?.systemPrompt).to.deep.equal({
      sourceIds: ['prompt-file:rules.md'],
      title: 'rules.md',
      text: 'Be terse.',
    });
  });

  it('binds the provider and model the first send picks', async () => {
    script = scripted(text('the reply'));
    const other = {
      id: 'account-2',
      label: 'Other account',
      baseUrl: 'https://other.invalid/v1',
      apiKey: 'other key',
      models: [
        { id: 'other-model', vision: false },
        { id: 'other-vision', vision: true },
      ],
    };
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [ACCOUNT, other],
      defaultProviderId: ACCOUNT.id,
      defaultModel: 'test-model',
    });
    const chat = engine.create();
    const picks = { providerId: other.id, model: 'other-model' };
    expect(await engine.send({ chatId: chat.id, text: 'hello', images: [], ...picks })).to.equal(true);
    await waitFor(() => !engine.isRunning(chat.id));
    expect(engine.get(chat.id)).to.include({ boundProviderId: 'account-2', boundModel: 'other-model' });
  });

  it('dispatches the task a chat waits for on an empty first send', async () => {
    const tasks = await taskStore();
    const task = await createTask(tasks);
    script = scripted(completion(task.id), text('done'));
    engine = await open({ tasks });
    const chat = engine.create(task.id);
    expect(chat).to.include({ title: 'Sort the files', waitingTaskId: task.id });
    engine.remoteSend(chat.fileId, '');
    await settleTask(tasks, task.id, chat.id);
    // The brief is the message. The completion and its reply follow.
    expect(engine.get(chat.id)?.entries.map((entry) => entry.role)).to.deep.equal(['user', 'assistant', 'tool', 'assistant']);
    expect(engine.get(chat.id)?.entries[0]?.content.startsWith(`[task ${task.id}] Sort the files`)).to.equal(true);
    // The record ran in the chat, the chat no longer waits, and no second chat opened for the task.
    expect(tasks.get(task.id)).to.include({ status: 'review', sessionFileId: chat.fileId, sessionChatId: chat.id });
    expect(engine.get(chat.id)).to.include({ taskId: task.id });
    expect(engine.get(chat.id)).to.not.have.property('waitingTaskId');
    expect(engine.list()).to.have.lengthOf(1);
  });

  it('lands the brief before the message of a first send, and binds its picks', async () => {
    const tasks = await taskStore();
    const task = await createTask(tasks);
    script = scripted(completion(task.id), text('done'));
    engine = await open({ tasks, promptSources: [{ id: 'agents-md', label: 'AGENTS.md', build: async () => 'Be terse.' }] });
    const chat = engine.create(task.id);
    const call = { chatId: chat.id, text: 'Start with the specs.', images: [], systemPromptIds: ['agents-md'] };
    expect(await engine.send(call)).to.equal(true);
    await settleTask(tasks, task.id, chat.id);
    expect(engine.get(chat.id)?.entries[0]?.content.startsWith(`[task ${task.id}]`)).to.equal(true);
    expect(engine.get(chat.id)?.entries[1]?.content).to.equal('Start with the specs.');
    expect(engine.get(chat.id)?.systemPrompt).to.deep.equal({ sourceIds: ['agents-md'], title: 'AGENTS.md', text: 'Be terse.' });
    // The model reads the system prompt, then the brief, then the message.
    expect(script.requests[0]?.messages.map((message) => message.role)).to.deep.equal(['system', 'user', 'user']);
  });

  it('keeps a blocked task queued on the chat that sent it', async () => {
    const tasks = await taskStore();
    const blocker = await createTask(tasks);
    const task = await createTask(tasks, [blocker.id]);
    engine = await open({ tasks });
    const chat = engine.create(task.id);
    expect(await engine.send({ chatId: chat.id, text: '', images: [] })).to.equal(false);
    expect(tasks.get(task.id)).to.include({ status: 'queued', dispatchMode: 'session', sessionFileId: chat.fileId });
    expect(engine.get(chat.id)?.entries.map((entry) => entry.role)).to.deep.equal(['notice']);
    expect(engine.get(chat.id)).to.not.have.property('waitingTaskId');
    expect(script.requests).to.have.lengthOf(0);
  });

  it('refuses an empty send on a chat that waits for no task', async () => {
    const chat = engine.create();
    expect(await engine.send({ chatId: chat.id, text: '', images: [] })).to.equal(false);
    engine.remoteSend(chat.fileId, '');
    expect(engine.get(chat.id)?.entries).to.deep.equal([]);
  });

  it('refuses a chat for a task that is missing or is no draft', async () => {
    const tasks = await taskStore();
    const task = await createTask(tasks);
    await tasks.cancel(task.id, 'Not needed.');
    engine = await open({ tasks });
    expect(() => engine.create('missing-task')).to.throw('no draft');
    expect(() => engine.create(task.id)).to.throw('no draft');
  });

  it('stops the turn of a cancelled task and tells its session', async () => {
    const tasks = await taskStore();
    const task = await createTask(tasks);
    script = abortable();
    engine = await open({ tasks });
    // The worker core wires the settle listener the same way.
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    const chat = engine.create(task.id);
    expect(await engine.send({ chatId: chat.id, text: '', images: [] })).to.equal(true);
    await waitFor(() => script.requests.length === 1 && tasks.get(task.id)?.status === 'running');
    // A cancel from outside: the board, the phone, or the origin agent.
    await tasks.cancel(task.id, 'Not needed.');
    await waitFor(() => !engine.isRunning(chat.id));
    const entries = engine.get(chat.id)?.entries ?? [];
    // The session reads why as user text, so the next request carries it to the model.
    expect(entries.at(-2)?.role).to.equal('user');
    expect(entries.at(-2)?.content).to.equal(
      `[task ${task.id}] The task was cancelled: Not needed.\nIt needs no more work: do not call the tasks tool for it again.`,
    );
    expect(entries.at(-1)).to.include({ role: 'notice', content: 'Stopped.' });
    expect(script.requests).to.have.lengthOf(1);
  });

  it('binds the default prompt on a dispatch, and the picks of the origin chat on an agent dispatch', async () => {
    const other = {
      id: 'account-2',
      label: 'Other account',
      baseUrl: 'https://other.invalid/v1',
      apiKey: 'other key',
      models: [{ id: 'other-model', vision: false }],
    };
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [ACCOUNT, other],
      defaultProviderId: ACCOUNT.id,
      defaultModel: 'test-model',
    });
    script = scripted(text('done'));
    const tasks = await taskStore();
    engine = await open({
      tasks,
      promptSources: [
        { id: 'agents-md', label: 'AGENTS.md', build: async () => 'Be terse.' },
        { id: 'rules', label: 'Rules', build: async () => 'Use the read tool.' },
      ],
    });
    const origin = engine.create();
    const picks = { providerId: other.id, model: 'other-model', systemPromptIds: ['rules'] };
    expect(await engine.send({ chatId: origin.id, text: 'hello', images: [], ...picks })).to.equal(true);
    await waitFor(() => !engine.isRunning(origin.id));
    const userTask = (await tasks.create({
      title: 'User task',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await tasks.dispatch(userTask.id, 'new-session', null);
    await engine.dispatch(userTask.id, 'new-session', null);
    // A task of the user inherits nothing: its session binds the default source and connection.
    const userChat = engine.list().find((chat) => chat.taskId === userTask.id);
    expect(userChat?.systemPrompt).to.deep.equal({ sourceIds: ['agents-md'], title: 'AGENTS.md', text: 'Be terse.' });
    expect(userChat).to.include({ boundProviderId: ACCOUNT.id, boundModel: 'test-model' });
    const agentTask = (await tasks.create({
      title: 'Agent task',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: origin.id,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await tasks.dispatch(agentTask.id, 'new-session', null);
    await engine.dispatch(agentTask.id, 'new-session', null);
    // The child of an agent reads the prompt of its parent and runs on its connection.
    const agentChat = engine.list().find((chat) => chat.taskId === agentTask.id);
    expect(agentChat?.systemPrompt).to.deep.equal({ sourceIds: ['rules'], title: 'Rules', text: 'Use the read tool.' });
    expect(agentChat).to.include({ boundProviderId: 'account-2', boundModel: 'other-model' });
  });

  it('nudges a running task after a restore and pumps the queued ones', async () => {
    const tasks = await taskStore();
    const running = await createTask(tasks);
    const queued = await createTask(tasks);
    script = abortable();
    engine = await open({ tasks });
    await tasks.dispatch(running.id, 'new-session', null);
    engine.pumpTasks();
    await waitFor(() => script.requests.length === 1 && tasks.get(running.id)?.status === 'running');
    // The app run ends mid-turn: the session file keeps the brief, and the record stays running.
    const firstChatId = tasks.get(running.id)?.sessionChatId;
    engine.stop(firstChatId ?? 0);
    await waitFor(() => typeof firstChatId === 'number' && !engine.isRunning(firstChatId));
    await tasks.dispatch(queued.id, 'new-session', null);
    // A new app run restores the sessions, then resumes the records.
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (request.messages.some((message) => message.role === 'tool')) {
          return text('done');
        }
        const text_ = request.messages.map((message) => message.content).join('\n');
        return completion(text_.includes(`[task ${running.id}]`) ? running.id : queued.id);
      },
    };
    engine = await open({ tasks });
    await engine.restore();
    engine.recoverTasks();
    await waitFor(() => tasks.get(running.id)?.status === 'review' && tasks.get(queued.id)?.status === 'review');
    const resumed = engine.list().find((chat) => chat.taskId === running.id);
    expect(resumed?.entries.map((entry) => entry.role)).to.deep.equal(['user', 'notice', 'user', 'assistant', 'tool', 'assistant']);
    expect(resumed?.entries[2]?.content).to.contain('The app restarted while the task ran.');
    // The queued record opened one session of its own.
    expect(engine.list().filter((chat) => chat.taskId === queued.id)).to.have.lengthOf(1);
  });

  it('sends a message that sends now after the tool results of the running batch', async () => {
    let releaseTool: () => void = () => {};
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        return requests.length === 1 ?
          { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'list_pages', arguments: '{}' }] } :
          text('done');
      },
    };
    engine = await open({
      main: {
        ...main,
        runWindowTool: async (name, args, source) => {
          windowCalls.push({ name, args, source });
          await new Promise<void>((resolve) => {
            releaseTool = resolve;
          });
          return { content: [{ type: 'text', text: `ran ${name}` }] };
        },
      },
    });
    const chat = engine.create();
    expect(await engine.send({ chatId: chat.id, text: 'first', images: [] })).to.equal(true);
    // The reply that calls the tool settled, and the tool runs.
    await waitFor(() => windowCalls.length === 1);
    expect(await engine.send({ chatId: chat.id, text: 'steer', images: [] })).to.equal(true);
    const queuedIndex = engine.get(chat.id)?.entries.findIndex((entry) => entry.queued) ?? -1;
    await engine.sendNow(chat.id, queuedIndex);
    expect(engine.get(chat.id)?.entries.map((entry) => entry.role)).to.deep.equal(['user', 'assistant', 'user']);
    releaseTool();
    await waitFor(() => !engine.isRunning(chat.id));
    // The entries keep the order in which they landed. The wire sends each result right under its call.
    expect(engine.get(chat.id)?.entries.map((entry) => entry.content)).to.deep.equal(['first', '', 'steer', 'ran list_pages', 'done']);
    expect(requests[1]?.messages.map((message) => `${message.role}:${message.content}`)).to.deep.equal([
      'user:first',
      'assistant:',
      'tool:ran list_pages',
      'user:steer',
    ]);
  });

  it('wraps a task up when its turn budget runs low: the write-back tools stay, and the agent settles it', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      maxTurns: 4,
    }))!;
    const call = { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'list_pages', arguments: '{}' }] };
    script = scripted(call, call, completion(task.id), text('done'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The first round ran its call. The second round reached the turn reserve, so its call refused.
    expect(windowCalls).to.have.lengthOf(1);
    const entries = engine.list().find((chat) => chat.taskId === task.id)?.entries ?? [];
    // Three tool entries: the call of the first round, the refusal of the second, and the completion of the third.
    const toolEntries = entries.filter((entry) => entry.role === 'tool');
    expect(toolEntries).to.have.lengthOf(3);
    expect(toolEntries[1]?.content).to.contain('[task budget]');
    // The wrap-up round offered the write-back tools only, and the completion of the agent stands.
    // A wrap-up ends the turn when the agent settles the task, so no closing round follows it.
    expect((script.requests[2]?.tools ?? []).map((tool) => tool.name).sort()).to.deep.equal(['files', 'tasks', 'write']);
    expect(tasks.get(task.id)).to.include({ status: 'review', turns: 3, endCause: null });
  });

  it('ends a task as exhausted when the wrap-up answer is plain text', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      maxTurns: 4,
    }))!;
    const call = { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'list_pages', arguments: '{}' }] };
    script = scripted(call, call, text('out of budget'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    expect(tasks.get(task.id)).to.include({ status: 'exhausted', endCause: 'turn-budget', turns: 3 });
    // The session reads the end.
    const entries = engine.list().find((chat) => chat.taskId === task.id)?.entries ?? [];
    expect(entries.at(-1)).to.include({ role: 'notice', content: `The task ${task.id} ended as exhausted: its budget ran out.` });
  });

  it('wraps a task up when the round that reaches its budget ends in plain text', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      maxTurns: 4,
    }))!;
    const call = { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'list_pages', arguments: '{}' }] };
    script = scripted(call, text('all sorted'), text('out of budget'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The second round reached the turn reserve and ended in text. The third round was the wrap-up,
    // and its plain text answer ended the task.
    expect(tasks.get(task.id)).to.include({ status: 'exhausted', endCause: 'turn-budget', turns: 3 });
    expect(script.requests).to.have.lengthOf(3);
    expect((script.requests[2]?.tools ?? []).map((tool) => tool.name).sort()).to.deep.equal(['files', 'tasks', 'write']);
  });

  it('ends the turn when the round that reaches the budget settles the task, so no wrap-up follows', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      maxTurns: 3,
    }))!;
    script = scripted(completion(task.id), text('unused'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The first round reached the turn reserve, and its call completed the task.
    expect(tasks.get(task.id)).to.include({ status: 'review', turns: 1 });
    expect(script.requests).to.have.lengthOf(1);
    const entries = engine.list().find((chat) => chat.taskId === task.id)?.entries ?? [];
    expect(entries.some((entry) => entry.content.includes('[task budget]'))).to.equal(false);
  });

  it('runs a turn as the wrap-up when the budget of the task sits at its reserve from the start', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      maxTurns: 2,
    }))!;
    const call = { content: '', model: 'test-model', toolCalls: [{ id: 'call-1', name: 'list_pages', arguments: '{}' }] };
    script = scripted(call, text('cannot work'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // Two rounds leave no round before the reserve, so the first round offered the write-back tools only.
    expect((script.requests[0]?.tools ?? []).map((tool) => tool.name).sort()).to.deep.equal(['files', 'tasks', 'write']);
    expect(tasks.get(task.id)).to.include({ status: 'exhausted', endCause: 'turn-budget', turns: 2 });
  });

  it('ends a task as timeout when its time limit passes', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      timeoutMs: 200,
    }))!;
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: (request) => {
        requests.push(request);
        if (requests.length > 1) {
          return Promise.resolve(text('stopped at the limit'));
        }
        return new Promise<CompletionResult>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new Error('The request was aborted.'));
          });
        });
      },
    };
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'timeout' && engine.list().every((chat) => !chat.running));
    // The limit stopped the first request, and one wrap-up round answered in text.
    expect(requests).to.have.lengthOf(2);
    expect(JSON.stringify(requests[1]?.messages)).to.contain('[task timeout]');
    expect(tasks.get(task.id)).to.include({ status: 'timeout', endCause: 'timeout' });
  });

  it('retries a failed round of a task on its connection, and clears the retries once a round comes back', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (requests.length <= 2) {
          throw new Error('429 rate limited');
        }
        return requests.length === 3 ? completion(task.id) : text('done');
      },
    };
    engine = await open({ tasks, taskRetryDelayMs: 1 });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    // The dispatch answers after the first turn failed. The retries run on their own, past their backoff.
    await engine.dispatch(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    // Two failed rounds, then the round that came back and its answer.
    expect(requests).to.have.lengthOf(4);
    const chat = engine.list().find((candidate) => candidate.taskId === task.id);
    expect(chat?.boundProviderId).to.equal(ACCOUNT.id);
    expect(chat?.entries.filter((entry) => entry.role === 'error').map((entry) => entry.content)).to.deep.equal([
      '429 rate limited',
      '429 rate limited',
    ]);
  });

  it('moves a task to the next account of the registry when its retries run out', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      retries: 0,
    }))!;
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [
        ACCOUNT,
        { id: 'account-2', label: 'Other account', baseUrl: 'https://other.invalid/v1', apiKey: 'other key', models: [{ id: 'other-model', vision: false }] },
      ],
      defaultProviderId: ACCOUNT.id,
      defaultModel: 'test-model',
    });
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          throw new Error('503 overloaded');
        }
        return requests.length === 2 ? completion(task.id) : text('done');
      },
    };
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    const chat = engine.list().find((candidate) => candidate.taskId === task.id);
    // The record names no chain, so the other account of the registry took over with its model.
    expect(chat).to.include({ boundProviderId: 'account-2', boundModel: 'other-model' });
    expect(chat?.entries.some((entry) => entry.content.includes('The task continues on the next connection'))).to.equal(true);
  });

  it('fails a task by its provider when its retries and its chain run out', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      retries: 0,
    }))!;
    script = {
      requests: [],
      answer: async () => {
        throw new Error('401 wrong key');
      },
    };
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'failed');
    expect(tasks.get(task.id)?.endCause).to.equal('provider');
    expect(tasks.get(task.id)?.note).to.contain('401 wrong key');
  });

  it('walks each other account of the registry once when the retries of a task run out', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      retries: 0,
    }))!;
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [
        ACCOUNT,
        { id: 'account-2', label: 'Second account', baseUrl: 'https://second.invalid/v1', apiKey: 'second key', models: [{ id: 'second-model', vision: false }] },
        { id: 'account-3', label: 'Third account', baseUrl: 'https://third.invalid/v1', apiKey: 'third key', models: [{ id: 'third-model', vision: false }] },
      ],
      // The task starts on the third account, which is not the first account of the registry.
      defaultProviderId: 'account-3',
      defaultModel: 'third-model',
    });
    script = {
      requests: [],
      answer: async () => {
        throw new Error('503 overloaded');
      },
    };
    engine = await open({ tasks, taskRetryDelayMs: 1 });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'failed');
    // The chain is built once, from the connection the task started on. Each other account runs once,
    // in the order of the registry.
    expect(providerAccounts).to.deep.equal([
      'https://third.invalid/v1',
      'https://provider.invalid/v1',
      'https://second.invalid/v1',
    ]);
    expect(tasks.get(task.id)?.endCause).to.equal('provider');
  });

  it('gives each connection of the chain the retries of the record', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [
        ACCOUNT,
        { id: 'account-2', label: 'Other account', baseUrl: 'https://other.invalid/v1', apiKey: 'other key', models: [{ id: 'other-model', vision: false }] },
      ],
      defaultProviderId: ACCOUNT.id,
      defaultModel: 'test-model',
    });
    script = {
      requests: [],
      answer: async () => {
        throw new Error('503 overloaded');
      },
    };
    engine = await open({ tasks, taskRetryDelayMs: 1 });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'failed');
    // The default count of two retries holds on the first connection and again on the next one.
    expect(providerAccounts).to.deep.equal([
      'https://provider.invalid/v1',
      'https://provider.invalid/v1',
      'https://provider.invalid/v1',
      'https://other.invalid/v1',
      'https://other.invalid/v1',
      'https://other.invalid/v1',
    ]);
    expect(tasks.get(task.id)?.endCause).to.equal('provider');
  });

  it('starts the queued tasks by priority under the cap of the workspace, and holds the rest', async () => {
    const tasks = await taskStore();
    await new WorkspaceSettingsStore(backend).saveTaskConcurrency(1);
    const draft = { description: 'Alphabetical order.', goal: '', origin: 'user' as const, originChatId: null, parentTaskId: null, blockedBy: [] };
    const low = (await tasks.create({ ...draft, title: 'Low', priority: 2 }))!;
    const high = (await tasks.create({ ...draft, title: 'High', priority: 9 }))!;
    let release: () => void = () => {};
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        if (request.messages.some((message) => message.role === 'tool')) {
          return text('done');
        }
        const text_ = request.messages.map((message) => message.content).join('\n');
        return completion(text_.includes(`[task ${high.id}]`) ? high.id : low.id);
      },
    };
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(low.id, 'new-session', null);
    await tasks.dispatch(high.id, 'new-session', null);
    engine.pumpTasks();
    // The higher priority took the one slot of the cap, and the lower one stayed queued.
    await waitForMs(() => requests.length === 1);
    expect(tasks.get(high.id)?.status).to.equal('running');
    expect(tasks.get(low.id)?.status).to.equal('queued');
    release();
    await waitForMs(() => tasks.get(high.id)?.status === 'review' && tasks.get(low.id)?.status === 'review');
    // The sessions opened in queue order.
    expect(engine.list().map((chat) => chat.taskId)).to.deep.equal([high.id, low.id]);
  });

  it('starts a task once when the queue pump wakes beside a direct dispatch', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    script = scripted(completion(task.id), text('done'));
    engine = await open({ tasks });
    // The worker core wires the pump on every record change, the way this spec does.
    tasks.subscribe(() => engine.pumpTasks());
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    const chat = engine.create();
    // The queue step wakes the pump before the direct dispatch runs, as the board path does.
    const queued = await tasks.dispatch(task.id, 'session', chat.fileId);
    expect(queued?.status).to.equal('queued');
    const outcome = await engine.dispatch(task.id, 'session', chat.fileId, false);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((candidate) => !candidate.running));
    // One brief reached the session, and no refusal of a second start landed beside it.
    const entries = engine.get(chat.id)?.entries ?? [];
    expect(entries.filter((entry) => entry.content.startsWith(`[task ${task.id}]`))).to.have.lengthOf(1);
    expect(entries.some((entry) => entry.content.includes('left the queue before this chat took it'))).to.equal(false);
    expect(outcome).to.contain('The task entered the session');
  });

  it('proves a goal with a command the session ran, and refuses a patch it never proposed', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      goals: ['The tests pass'],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    script = scripted(
      call('run-1', 'run', { command: 'npm test' }),
      call('prove-1', 'tasks', { action: 'prove', id: task.id, goal: 1, evidence: [{ kind: 'patch', id: 999 }] }),
      call('prove-2', 'tasks', { action: 'prove', id: task.id, goal: 1, evidence: [{ kind: 'command', command: 'npm test' }] }),
      completion(task.id),
      text('done'),
    );
    // The run of the session answers like a command that passed.
    const passing = {
      ...main,
      runWindowTool: async (name: string) => ({ content: [{ type: 'text' as const, text: name === 'run' ? 'exit code: 0\nstdout:\nok' : `ran ${name}` }] }),
    };
    engine = await open({ tasks, main: passing });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    expect(tasks.get(task.id)?.status).to.equal('review');
    // The command the session ran proved the goal. The patch it never proposed did not.
    expect(tasks.get(task.id)?.goals[0]).to.deep.equal({
      text: 'The tests pass',
      met: true,
      evidence: [{ kind: 'command', command: 'npm test' }],
    });
    const toolEntries = (engine.list().find((chat) => chat.taskId === task.id)?.entries ?? []).filter((entry) => entry.role === 'tool');
    expect(toolEntries[1]?.content).to.contain('refused its items');
    expect(toolEntries[2]?.content).to.contain('Every goal is met');
    // The brief told the session to prove each goal before it completes the task.
    expect(JSON.stringify(script.requests[0]?.messages)).to.contain('Goals to prove');
  });

  it('blocks a task on the question of its session, and runs it on when the operator answers', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    script = scripted(
      call('ask-1', 'tasks', { action: 'ask', id: task.id, question: 'Which file sorts first?' }),
      text('I will wait for the answer.'),
      completion(task.id),
      text('done'),
    );
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The turn ended after the question, and the task waits without a nudge.
    expect(tasks.get(task.id)).to.include({ status: 'blocked', question: 'Which file sorts first?' });
    expect(engine.isRunning(tasks.get(task.id)?.sessionChatId ?? 0)).to.equal(false);
    // The operator answers from the board or the phone, and the session takes the task up again.
    expect(await engine.answerTask(task.id, 'Z first.')).to.contain('runs again');
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    const entries = engine.list().find((chat) => chat.taskId === task.id)?.entries ?? [];
    expect(entries.some((entry) => entry.content === `[task ${task.id}] The operator answered: Z first.`)).to.equal(true);
    // The session made the question, answered in text, then took the completion and its reply: four requests.
    expect(script.requests).to.have.lengthOf(4);
  });

  it('cancels a blocked task when its session tab closes', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    script = scripted(call('ask-1', 'tasks', { action: 'ask', id: task.id, question: 'Which file?' }), text('Waiting.'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    const chatId = tasks.get(task.id)?.sessionChatId ?? 0;
    expect(tasks.get(task.id)?.status).to.equal('blocked');
    // The session is gone, so the task cannot run on. It cancels with the cause of the close.
    engine.close(chatId);
    await waitForMs(() => tasks.get(task.id)?.status === 'cancelled');
    expect(tasks.get(task.id)).to.include({ endCause: 'session-closed', question: null });
    expect(engine.list()).to.have.lengthOf(0);
  });

  it('queues the answer behind a turn of the session that still runs, then delivers it', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    let release: () => void = () => {};
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (requests.length === 2) {
          // The closing reply of the session is in flight when the operator answers.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return text('I will wait for the answer.');
        }
        if (requests.length === 1) {
          return call('ask-1', 'tasks', { action: 'ask', id: task.id, question: 'Which file?' });
        }
        return requests.length === 3 ? completion(task.id) : text('done');
      },
    };
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    // The pump starts the session on its own, so the test acts while the session still runs.
    engine.pumpTasks();
    await waitForMs(() => requests.length === 2 && tasks.get(task.id)?.status === 'blocked');
    const chatId = tasks.get(task.id)?.sessionChatId ?? 0;
    expect(engine.isRunning(chatId)).to.equal(true);
    expect(await engine.answerTask(task.id, 'Z first.')).to.contain('queued behind the turn');
    expect(tasks.get(task.id)?.status).to.equal('running');
    release();
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    // The answer reached the session after the closing reply, and it needed no nudge.
    const entries = engine.get(chatId)?.entries ?? [];
    const answered = entries.findIndex((entry) => entry.content === `[task ${task.id}] The operator answered: Z first.`);
    expect(answered).to.be.greaterThan(entries.findIndex((entry) => entry.content === 'I will wait for the answer.'));
    expect(entries.some((entry) => entry.content.includes('without a completion'))).to.equal(false);
  });

  it('fails a task before its session starts when a system prompt source fails to build', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const child = (await tasks.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: task.id,
      blockedBy: [task.id],
    }))!;
    await tasks.dispatch(child.id, 'new-session', null);
    script = scripted(text('unused'));
    engine = await open({
      tasks,
      promptSources: [{ id: 'agents-md', label: 'AGENTS.md', build: async () => { throw new Error('unreadable'); } }],
    });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    const outcome = await engine.dispatch(task.id, 'new-session', null);
    // No round ran. The record failed with the cause in its note, and the queued child it held failed with it.
    expect(script.requests).to.have.lengthOf(0);
    expect(tasks.get(task.id)).to.include({ status: 'failed', endCause: 'session-start' });
    expect(tasks.get(task.id)?.note).to.contain('The system prompt source "AGENTS.md" failed: unreadable');
    expect(tasks.get(child.id)).to.include({ status: 'failed', endCause: 'cascade' });
    expect(outcome).to.contain('failed before its session started');
  });

  it('returns a failed task and the children it failed to the queue on a retry, in a new session', async () => {
    const tasks = await taskStore();
    const brief = { description: 'Alphabetical order.', goal: 'ls reads sorted', origin: 'user' as const, originChatId: null, blockedBy: [] as string[] };
    const task = (await tasks.create({ ...brief, title: 'First half', parentTaskId: null }))!;
    const child = (await tasks.create({ ...brief, title: 'Second half', parentTaskId: task.id, blockedBy: [task.id] }))!;
    const grandchild = (await tasks.create({ ...brief, title: 'Third half', parentTaskId: child.id, blockedBy: [child.id] }))!;
    await tasks.dispatch(child.id, 'new-session', null);
    await tasks.dispatch(grandchild.id, 'new-session', null);
    let broken = true;
    const source = {
      id: 'agents-md',
      label: 'AGENTS.md',
      build: async (): Promise<string> => {
        if (broken) {
          throw new Error('unreadable');
        }
        return 'Be terse.';
      },
    };
    engine = await open({ tasks, promptSources: [source] });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The prompt source failed, so the task failed before its session started, and its line failed with it.
    expect(tasks.get(task.id)?.status).to.equal('failed');
    expect(tasks.get(child.id)).to.include({ status: 'failed', endCause: 'cascade' });
    expect(tasks.get(grandchild.id)).to.include({ status: 'failed', endCause: 'cascade' });
    const failedChatId = tasks.get(task.id)?.sessionChatId ?? 0;
    // The source builds again. One retry returns the whole line: the task runs, and its children wait on it again.
    broken = false;
    script = scripted(completion(task.id), text('done'));
    const outcome = await engine.retryTask(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    expect(outcome).to.contain('returns to the queue on a new session. 2 failed children return to the queue with it.');
    expect(tasks.get(task.id)?.status).to.equal('review');
    expect(tasks.get(child.id)?.status).to.equal('queued');
    expect(tasks.get(grandchild.id)?.status).to.equal('queued');
    // The retry opened a new chat, and the chat of the failed run no longer holds the task.
    expect(tasks.get(task.id)?.sessionChatId).to.not.equal(failedChatId);
    expect(engine.get(failedChatId)?.taskId).to.equal(undefined);
  });

  it('retries a failed task in a chat the caller names, and refuses a session that holds no open tab', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'First half',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    // The child waited on a session that is not open.
    const child = (await tasks.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: task.id,
      blockedBy: [task.id],
    }))!;
    await tasks.dispatch(task.id, 'new-session', null);
    await tasks.bindSession(task.id, 9, 'session-file-9');
    await tasks.dispatch(child.id, 'session', 'session-file-closed');
    await tasks.fail(task.id, 'The provider never answered.', 'provider');
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    // A session that holds no open tab refuses the retry, so the record never waits on a dead session.
    expect(await engine.retryTask(task.id, 'session', 'no-such-file')).to.contain('holds no open tab');
    expect(tasks.get(task.id)?.status).to.equal('failed');
    // An open chat takes the retry. The child keeps its own session, which closed, so it returns to draft.
    const chat = engine.create();
    script = scripted(completion(task.id), text('done'));
    const outcome = await engine.retryTask(task.id, 'session', chat.fileId);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat_) => !chat_.running));
    expect(outcome).to.contain(`returns to the queue on the session "${chat.title}". 1 failed child returns to draft`);
    expect(tasks.get(task.id)?.sessionChatId).to.equal(chat.id);
    expect(tasks.get(child.id)?.status).to.equal('draft');
    // A record that is not failed does not retry.
    expect(await engine.retryTask(task.id, 'new-session', null)).to.contain('Only a task that failed, or ended by a limit, retries');
  });

  it('retries a task that ended exhausted, with the children that failed through it', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'First half',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const child = (await tasks.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: task.id,
      blockedBy: [task.id],
    }))!;
    await tasks.dispatch(task.id, 'new-session', null);
    await tasks.bindSession(task.id, 9, 'session-file-9');
    await tasks.dispatch(child.id, 'new-session', null);
    await tasks.endRun(task.id, 'exhausted', 'turn-budget');
    expect(tasks.get(child.id)?.status).to.equal('failed');
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    script = scripted(completion(task.id), text('done'));
    const outcome = await engine.retryTask(task.id, 'new-session', null);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    // The retry started with a full budget and a clean record. One round completed the task, and the
    // closing reply of the session counts as the second.
    expect(tasks.get(task.id)).to.include({ status: 'review', turns: 2, endCause: null });
    // The child of the ended line returns with it, and it waits on the task again.
    expect(tasks.get(child.id)?.status).to.equal('queued');
    expect(outcome).to.contain('1 failed child returns to the queue with it.');
  });

  it('lets the session that cancels its own task end its turn without a stop notice', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    script = scripted(call('cancel-1', 'tasks', { action: 'cancel', id: task.id, reason: 'Called off.' }), text('The task is closed.'));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The turn of the session ran the cancel, so it ran on to its closing reply. A stop notice means an abort.
    expect(tasks.get(task.id)).to.include({ status: 'cancelled', endCause: 'agent' });
    expect(script.requests).to.have.lengthOf(2);
    const entries = engine.list().find((chat) => chat.taskId === task.id)?.entries ?? [];
    expect(entries.some((entry) => entry.content === 'Stopped.')).to.equal(false);
    expect(entries.at(-1)?.content).to.equal('The task is closed.');
  });

  it('takes a message typed into the session as the answer while its task waits on a question', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    script = scripted(
      call('ask-1', 'tasks', { action: 'ask', id: task.id, question: 'Which file sorts first?' }),
      text('Waiting.'),
      completion(task.id),
      text('done'),
    );
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    expect(tasks.get(task.id)?.status).to.equal('blocked');
    // The operator types the answer into the session tab, and not into the ask card.
    const chatId = tasks.get(task.id)?.sessionChatId ?? 0;
    expect(await engine.send({ chatId, text: 'Z first.', images: [] })).to.equal(true);
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    const entries = engine.get(chatId)?.entries ?? [];
    expect(entries.some((entry) => entry.content === `[task ${task.id}] The operator answered: Z first.`)).to.equal(true);
    // The question, the closing reply, the completion, and the reply: four requests.
    expect(script.requests).to.have.lengthOf(4);
  });

  it('holds an answered task in the queue while the workspace has no slot, then delivers the held answer first', async () => {
    await new WorkspaceSettingsStore(backend).saveTaskConcurrency(1);
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'First',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const other = (await tasks.create({
      title: 'Other',
      description: 'Alphabetical order.',
      goal: 'ls reads sorted',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    let release: () => void = () => {};
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return call('ask-1', 'tasks', { action: 'ask', id: task.id, question: 'Which file?' });
        }
        if (requests.length === 2) {
          return text('Waiting.');
        }
        if (requests.length === 3) {
          // The other task holds the one slot of the workspace until the test releases it.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return completion(other.id);
        }
        return requests.length === 5 ? completion(task.id) : text('done');
      },
    };
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    await tasks.dispatch(other.id, 'new-session', null);
    engine.pumpTasks();
    await waitForMs(() => requests.length === 3);
    const chatId = tasks.get(task.id)?.sessionChatId ?? 0;
    // No slot is free, so the answer waits in the session and the record returns to the queue.
    const outcome = await engine.answerTask(task.id, 'Z first.');
    expect(outcome).to.contain('waits in the queue');
    expect(tasks.get(task.id)).to.include({ status: 'queued', question: null, dispatchMode: 'session' });
    const held = `[task ${task.id}] The operator answered: Z first.`;
    expect((engine.get(chatId)?.entries ?? []).some((entry) => entry.content === held && entry.queued)).to.equal(true);
    // The other task settles, the slot frees, and the pump takes the record back into its chat.
    release();
    await waitForMs(() => tasks.get(task.id)?.status === 'review' && engine.list().every((chat) => !chat.running));
    const entries = engine.get(chatId)?.entries ?? [];
    // The session read its brief once, and the held answer started the turn.
    expect(entries.filter((entry) => entry.content.startsWith(`[task ${task.id}] First`)).length).to.equal(1);
    expect(entries.some((entry) => entry.content === held && !entry.queued)).to.equal(true);
    expect(requests).to.have.lengthOf(6);
  });

  it('refuses a proof that names a command the session ran without a clean exit', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      goals: ['The tests pass'],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    // The first run failed, the second never ran, and the third passed.
    const results = ['exit code: 1\nstderr:\nfailed', 'Error: The command was denied.', 'exit code: 0\nstdout:\nok'];
    let runs = 0;
    const flaky = {
      ...main,
      runWindowTool: async (_name: string) => {
        const text = results[Math.min(runs, results.length - 1)] ?? '';
        runs += 1;
        return { content: [{ type: 'text' as const, text }] };
      },
    };
    script = scripted(
      call('run-1', 'run', { command: 'npm test' }),
      call('run-2', 'run', { command: 'npm test' }),
      call('prove-1', 'tasks', { action: 'prove', id: task.id, goal: 1, evidence: [{ kind: 'command', command: 'npm test' }] }),
      call('run-3', 'run', { command: 'npm test' }),
      call('prove-2', 'tasks', { action: 'prove', id: task.id, goal: 1, evidence: [{ kind: 'command', command: 'npm test' }] }),
      completion(task.id),
      text('done'),
    );
    engine = await open({ tasks, main: flaky });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    expect(tasks.get(task.id)?.status).to.equal('review');
    const toolEntries = (engine.list().find((chat) => chat.taskId === task.id)?.entries ?? []).filter((entry) => entry.role === 'tool');
    // A failed run and a refused one proved nothing. The passing run met the goal.
    expect(toolEntries[2]?.content).to.contain('exited with code zero');
    expect(toolEntries[4]?.content).to.contain('Every goal is met');
    expect(tasks.get(task.id)?.goals[0]?.met).to.equal(true);
  });

  it('keeps the errors and the notices of a session in the transcript the read action answers', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    const requests: CompletionRequest[] = [];
    script = {
      requests,
      answer: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          throw new Error('boom');
        }
        if (requests.length === 2) {
          return call('read-1', 'tasks', { action: 'read', id: task.id, part: 'entries' });
        }
        return text('done');
      },
    };
    engine = await open({ tasks, taskRetryDelayMs: 1 });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The failed round, the retry that reads the transcript, the closing reply, and the nudge turn
    // that follows a turn without a completion: four requests or more.
    await waitForMs(() => script.requests.length >= 3 && engine.list().every((chat) => !chat.running));
    const toolEntries = (engine.list().find((chat) => chat.taskId === task.id)?.entries ?? []).filter((entry) => entry.role === 'tool');
    // The failed round stays in the transcript, so the chat that reads it learns why the session stalled.
    expect(toolEntries[0]?.content).to.contain('error: boom');
  });

  it('offers no tool while the task waits on its question, so the session only closes in text', async () => {
    const tasks = await taskStore();
    const task = (await tasks.create({
      title: 'Sort the files',
      description: 'Alphabetical order.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const call = (id: string, name: string, args: object): CompletionResult =>
      ({ content: '', model: 'test-model', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
    // The model calls a tool after its question, although the answer of the ask told it to end the turn.
    script = scripted(call('ask-1', 'tasks', { action: 'ask', id: task.id, question: 'Which file?' }), call('pages-1', 'list_pages', {}));
    engine = await open({ tasks });
    tasks.onSettle((record) => engine.handleTaskSettle(record));
    await tasks.dispatch(task.id, 'new-session', null);
    await engine.dispatch(task.id, 'new-session', null);
    // The closing round offered no tool, the call that came anyway ran nothing, and the turn ended there.
    expect(script.requests).to.have.lengthOf(2);
    expect(script.requests[1]?.tools).to.deep.equal([]);
    expect(windowCalls).to.have.lengthOf(0);
    expect(tasks.get(task.id)).to.include({ status: 'blocked', turns: 1 });
    expect(engine.list().every((chat) => !chat.running)).to.equal(true);
  });

  it('lists the connection menu without a key and without an address', async () => {
    const seeing = {
      id: 'account-2',
      label: 'Seeing account',
      baseUrl: 'https://seeing.invalid/v1',
      apiKey: 'seeing key',
      models: [{ id: 'seeing-model', vision: true }],
    };
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [ACCOUNT, seeing],
      defaultProviderId: seeing.id,
      defaultModel: 'seeing-model',
    });
    expect(await engine.connectionMenu()).to.deep.equal({
      accounts: [
        { id: 'account-1', label: 'Spec account', models: [{ id: 'test-model', label: 'test-model' }] },
        { id: 'account-2', label: 'Seeing account', models: [{ id: 'seeing-model', label: 'seeing-model · vision' }] },
      ],
      defaultProviderId: 'account-2',
      defaultModel: 'seeing-model',
    });
  });

  it('answers a send without a provider with a notice and no turn', async () => {
    await new WorkspaceSettingsStore(backend).saveProviderRegistry({
      accounts: [],
      defaultProviderId: null,
      defaultModel: null,
    });
    const chat = engine.create();
    expect(await engine.send({ chatId: chat.id, text: 'hello', images: [] })).to.equal(true);
    expect(script.requests).to.have.lengthOf(0);
    expect(engine.get(chat.id)?.entries[1]?.role).to.equal('notice');
  });

  it('stops the turn of a closed chat and leaves no session file behind', async () => {
    script = abortable();
    const chat = engine.create();
    await engine.send({ chatId: chat.id, text: 'hello', images: [] });
    await waitFor(() => script.requests.length === 1);
    engine.close(chat.id);
    await waitFor(() => !engine.isRunning(chat.id));
    expect(engine.list()).to.deep.equal([]);
    expect(engine.get(chat.id)).to.equal(null);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(existsSync(join(root, 'chats')) ? readdirSync(join(root, 'chats')) : []).to.deep.equal([]);
    // The closed chat pushed its removal, and nothing after it.
    expect(events.at(-1)).to.deep.equal({ kind: 'closed', chatId: chat.id });
  });

  it('closes the chat of one session file from the phone page, and leaves no session file', async () => {
    script = scripted(text('the reply'));
    const chatId = await turn('hello');
    const fileId = engine.get(chatId)?.fileId ?? '';
    await waitFor(() => existsSync(join(root, 'chats', `${fileId}.json`)));
    // An unknown session file closes nothing.
    engine.remoteClose('no-such-session');
    expect(engine.get(chatId)).to.not.equal(null);
    engine.remoteClose(fileId);
    expect(engine.list()).to.deep.equal([]);
    expect(events.at(-1)).to.deep.equal({ kind: 'closed', chatId });
    // The session file drops on the write chain of the store, so the removal lands a moment later.
    await waitFor(() => !existsSync(join(root, 'chats', `${fileId}.json`)));
    expect(readdirSync(join(root, 'chats'))).to.deep.equal([]);
  });

  it('restores the stored sessions of a workspace', async () => {
    script = scripted(text('the reply'));
    const chatId = await turn('hello');
    const fileId = engine.get(chatId)?.fileId ?? '';
    await waitFor(() => existsSync(join(root, 'chats', `${fileId}.json`)));
    engine = await open();
    await engine.restore();
    expect(engine.list().map((chat) => chat.id)).to.deep.equal([1]);
    expect(engine.list()[0]?.fileId).to.equal(fileId);
    expect(engine.list()[0]?.entries.map((entry) => entry.content)).to.deep.equal(['hello', 'the reply']);
    expect(engine.list()[0]?.running).to.equal(false);
  });
});
