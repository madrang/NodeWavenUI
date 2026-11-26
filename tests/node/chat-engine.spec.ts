/**
 * Specs for the chat engine of the worker core: a send runs a turn through the provider and
 * records the reply, the reply streams as deltas, a message queues behind a running turn, a stop
 * ends the turn, a tool call reaches main and its result returns to the model, the first send
 * binds the system prompt, a closed chat stops its turn and leaves no session file, and a new
 * engine restores the stored sessions. The provider and the services of the main process are fakes.
 */

import { expect } from 'chai';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine, type ChatEngineDeps, type EngineGate, type EngineMainCalls } from '../../dist/worker/chat-engine.js';
import { ChatSessionStore } from '../../dist/worker/chat-sessions.js';
import { PatchStore } from '../../dist/worker/patch-store.js';
import { TaskStore } from '../../dist/worker/task-store.js';
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

class FakeProvider implements InferenceProvider {
  readonly id = 'fake';

  constructor(_config: OpenAiProviderConfig) {}

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
    const chatSessions = new ChatSessionStore(root, settings, false);
    const deps: ChatEngineDeps = {
      workspacePath: root,
      gate,
      patches,
      tasks,
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
