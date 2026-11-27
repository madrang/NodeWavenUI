/**
 * Specs for the tasks tool: the wait action wakes on a record change, so a settle answers at once
 * and a change elsewhere holds the wait, the list action prints short ids that the other actions
 * resolve, and the list action narrows the rows to the children of one parent.
 */

import { expect } from 'chai';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type TaskCreateInput } from '../../dist/worker/task-store.js';
import { TaskTemplateStore } from '../../dist/worker/task-templates.js';
import { createTasksTool, type TaskToolDeps } from '../../dist/worker/task-tools.js';

/** One draft of the specs: a record of the agent of chat 7, with no brief and no goal. */
function draft(title: string, parentTaskId: string | null = null): TaskCreateInput {
  return { title, description: '', goal: '', origin: 'agent', originChatId: 7, parentTaskId, blockedBy: [] };
}

/** Yields to the event loop once, so a subscription of the test arms. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('the tasks tool', () => {
  let root: string;
  let store: TaskStore;
  let templates: TaskTemplateStore;
  let deps: TaskToolDeps;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nvtasktool-'));
    store = new TaskStore(root);
    await store.load();
    templates = new TaskTemplateStore(root);
    await templates.load();
    deps = {
      store,
      templates,
      dispatch: async () => '',
      retry: async () => '',
      send: async () => '',
      setTaskName: async () => '',
      verifyEvidence: (_task, evidence) => ({ verified: evidence, refused: [] }),
      readEntries: () => null,
      chatId: 7,
      check: { check: async () => {} },
      dispatchAllowed: () => false,
      source: 'spec',
    };
  });

  it('wakes the wait on the settle of the task it watches', async () => {
    const tool = createTasksTool(deps);
    const task = (await store.create(draft('Sort the files')))!;
    const waiting = tool.run({ action: 'wait', id: task.id, timeoutMs: 600000 });
    await tick();
    await store.cancel(task.id, 'Called off.');
    const output = await Promise.race([
      waiting,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('still waiting'), 1000);
      }),
    ]);
    // A poll of one second would keep the wait past the race.
    expect(output).to.not.equal('still waiting');
    expect((output as { text: string }).text).to.contain('Called off.');
  });

  it('holds the wait through a change elsewhere, then wakes on the settle', async () => {
    const tool = createTasksTool(deps);
    const task = (await store.create(draft('Sort the files')))!;
    let answered = false;
    const waiting = tool.run({ action: 'wait', id: task.id, timeoutMs: 600000 }).then((output) => {
      answered = true;
      return output;
    });
    await tick();
    // A record that lands changes the store, but the watched task still lives.
    await store.create(draft('Other work'));
    await tick();
    expect(answered).to.equal(false);
    await store.cancel(task.id, null);
    const output = await waiting;
    expect(output.text).to.contain('settled');
  });

  it('reads a task by the short id the list prints', async () => {
    const tool = createTasksTool(deps);
    const task = (await store.create(draft('Sort the files')))!;
    const list = await tool.run({ action: 'list' });
    const short = task.id.slice(0, 8);
    expect(list.text.startsWith(`${short} [draft] Sort the files`)).to.equal(true);
    const read = await tool.run({ action: 'read', id: short });
    expect(read.text).to.contain(`id: ${short} (${task.id})`);
  });

  it('lists the children of one parent', async () => {
    const tool = createTasksTool(deps);
    const parent = (await store.create(draft('Parent')))!;
    await store.create(draft('Child', parent.id));
    await store.create(draft('Unrelated'));
    const list = await tool.run({ action: 'list', parentTaskId: parent.id });
    expect(list.text.split('\n')).to.have.lengthOf(1);
    expect(list.text).to.contain('Child');
  });

  it('lets only the session that runs a task write its plan', async () => {
    const tool = createTasksTool(deps);
    const task = (await store.create(draft('Planned')))!;
    await store.dispatch(task.id, 'new-session', null);
    // A chat that does not run the task writes nothing.
    let refusal = '';
    try {
      await tool.run({ action: 'plan', id: task.id, steps: ['Read'] });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).to.contain('Only the session that runs');
    await store.bindSession(task.id, 7, 'session-file-7');
    const written = await tool.run({
      action: 'plan',
      id: task.id,
      steps: ['Read the files', { text: 'Sort them', state: 'in_progress' }, { text: 'Check', state: 'unknown' }],
    });
    expect(written.text).to.equal(`The plan of task ${task.id} holds 3 steps.`);
    // A bare text and an unknown state both read as pending.
    expect(store.get(task.id)?.plan).to.deep.equal([
      { text: 'Read the files', state: 'pending' },
      { text: 'Sort them', state: 'in_progress' },
      { text: 'Check', state: 'pending' },
    ]);
    const read = await tool.run({ action: 'read', id: task.id });
    expect(read.text).to.contain('☐ Read the files');
    expect(read.text).to.contain('▶ Sort them');
  });

  it('holds a completion while a goal stays open, and refuses a proof with evidence the engine refuses', async () => {
    const tool = createTasksTool(deps);
    const task = (await store.create({ ...draft('Proven'), goals: ['The tests pass'] }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    const refusal = async (call: Record<string, unknown>): Promise<string> => {
      try {
        await tool.run(call);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(await refusal({ action: 'complete', id: task.id, result: 'Done.' })).to.contain('keeps 1 open goals');
    // The engine refuses a patch the session never proposed.
    let holds = false;
    const verifying = (): TaskToolDeps => ({
      ...deps,
      verifyEvidence: (_task, evidence) => ({
        verified: holds ? evidence : [],
        refused: holds ? [] : ['patch 999 is no patch the session of the task proposed'],
      }),
    });
    let message = '';
    try {
      await createTasksTool(verifying()).run({ action: 'prove', id: task.id, goal: 1, evidence: [{ kind: 'patch', id: 999 }] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('refused its items');
    expect(store.get(task.id)?.goals[0]?.met).to.equal(false);
    holds = true;
    const proved = await createTasksTool(verifying()).run({
      action: 'prove',
      id: task.id,
      goal: 'The tests pass',
      evidence: [{ kind: 'patch', id: 999 }],
    });
    expect(proved.text).to.contain('Every goal is met');
    const done = await tool.run({ action: 'complete', id: task.id, result: 'Done.' });
    expect(done.text).to.contain('waits for the user review');
  });

  it('reads the transcript of the session when the caller asks for the entries', async () => {
    const task = (await store.create(draft('Read')))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    deps = { ...deps, readEntries: () => 'user: the brief\nassistant: the reply' };
    const reading = createTasksTool(deps);
    const transcript = await reading.run({ action: 'read', id: task.id, part: 'entries' });
    expect(transcript.text).to.equal('user: the brief\nassistant: the reply');
    // A chat that neither runs the task nor caused it reads no transcript.
    const outsider = createTasksTool({ ...deps, chatId: 8 });
    let message = '';
    try {
      await outsider.run({ action: 'read', id: task.id, part: 'entries' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('may not read the session');
  });

  it('lets only the session that runs a task ask its operator, and answers a wait with the question', async () => {
    const task = (await store.create(draft('Asking')))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    let message = '';
    try {
      await createTasksTool({ ...deps, chatId: 8 }).run({ action: 'ask', id: task.id, question: 'Which file?' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('may ask its operator');
    const asked = await createTasksTool(deps).run({ action: 'ask', id: task.id, question: 'Which file?' });
    expect(asked.text).to.contain('now waits (blocked)');
    // The wait of a parent answers with the question, so the parent can answer or wait again.
    const waiting = createTasksTool({ ...deps, chatId: 8 }).run({ action: 'wait', id: task.id, timeoutMs: 600000 });
    const answer = (await Promise.race([
      waiting,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('still waiting'), 1000);
      }),
    ])) as { text: string };
    expect(answer.text).to.contain('waits on the answer of the operator: Which file?');
  });

  it('creates a task from a template, and an argument of the create overrides the template', async () => {
    const tool = createTasksTool(deps);
    const template = await templates.save({
      ...(await store.create(draft('Cleanup')))!,
      description: 'Clean the build folders.',
      goal: 'The tree builds again.',
      category: 'Chores',
    });
    // The template fills the brief, the goal, and the category. The title of the call overrides.
    const created = await tool.run({ action: 'create', template: template.id.slice(0, 8), title: 'My cleanup' });
    expect(created.text).to.contain('My cleanup');
    const task = store.list().find((record) => record.title === 'My cleanup');
    expect(task).to.include({ description: 'Clean the build folders.', goal: 'The tree builds again.', category: 'Chores' });
    // The templates action lists the templates with their short ids and their categories.
    const listed = await tool.run({ action: 'templates' });
    expect(listed.text).to.contain('[Chores] Cleanup');
    // A template that matches no template refuses the create.
    let message = '';
    try {
      await tool.run({ action: 'create', template: 'no-such-template' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('matches no template');
  });

  it('reads a proof the way a model sends it: the goal as text, and the proof as JSON text', async () => {
    const task = (await store.create({ ...draft('Proven'), goals: ['The tests pass', 'The readme reads well'] }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    const tool = createTasksTool(deps);
    const proved = await tool.run({
      action: 'prove',
      id: task.id,
      goal: '2',
      proof: '[{"kind": "command", "command": "npm test"}]',
    });
    expect(proved.text).to.contain('Goal 2 of task');
    expect(store.get(task.id)?.goals.map((goal) => goal.met)).to.deep.equal([false, true]);
    // The proof also takes a list, and the goal its text.
    const again = await tool.run({ action: 'prove', id: task.id, goal: 'The tests pass', proof: [{ kind: 'patch', id: 4 }] });
    expect(again.text).to.contain('Every goal is met');
    // A proof that is no list still refuses.
    let refusal = '';
    try {
      await tool.run({ action: 'prove', id: task.id, goal: 1, proof: 'npm test' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).to.contain('needs a list');
  });

  it('takes the short id the list prints in every action that changes the record', async () => {
    let dispatchedAs = '';
    let sentTo = '';
    deps = {
      ...deps,
      dispatch: async (id) => {
        dispatchedAs = id;
        return 'A new chat session opened for the task.';
      },
      send: async (id) => {
        sentTo = id;
        return 'The message entered the session.';
      },
    };
    const tool = createTasksTool(deps);
    const task = (await store.create({ ...draft('Sorted'), goals: ['The tests pass'] }))!;
    const short = task.id.slice(0, 8);
    // The dispatch resolves the record first, so the store and the engine read the full id.
    await tool.run({ action: 'dispatch', id: short, mode: 'new-session' });
    expect(dispatchedAs).to.equal(task.id);
    expect(store.get(task.id)?.status).to.equal('queued');
    await store.bindSession(task.id, 7, 'session-file-7');
    expect((await tool.run({ action: 'plan', id: short, steps: ['Read'] })).text).to.contain('holds 1 steps');
    expect((await tool.run({ action: 'goals', id: short, goals: ['The tests pass'] })).text).to.contain('holds 1 goals');
    const proved = await tool.run({ action: 'prove', id: short, goal: 1, proof: [{ kind: 'command', command: 'npm test' }] });
    expect(proved.text).to.contain('Goal 1 of task');
    await tool.run({ action: 'send', id: short, message: 'Keep going.' });
    expect(sentTo).to.equal(task.id);
    expect((await tool.run({ action: 'ask', id: short, question: 'Which file?' })).text).to.contain('now waits (blocked)');
    await store.unblock(task.id);
    expect((await tool.run({ action: 'complete', id: short, result: 'Sorted.' })).text).to.contain('waits for the user review');
    expect((await tool.run({ action: 'cancel', id: short, reason: 'No longer needed.' })).text).to.contain('cancelled');
    expect((await tool.run({ action: 'reopen', id: short })).text).to.contain('reopened as a draft');
    expect(store.get(task.id)?.status).to.equal('draft');
    const other = (await store.create(draft('Failed')))!;
    await store.dispatch(other.id, 'new-session', null);
    await store.bindSession(other.id, 7, 'session-file-8');
    const failed = await tool.run({ action: 'fail', id: other.id.slice(0, 8), reason: 'No way through.' });
    expect(failed.text).to.contain('failed');
    expect(store.get(other.id)?.status).to.equal('failed');
  });

  it('refuses a goals action that names no goals, so a missing argument keeps the checklist', async () => {
    const task = (await store.create({ ...draft('Kept'), goals: ['The tests pass'] }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    let message = '';
    try {
      await createTasksTool(deps).run({ action: 'goals', id: task.id });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('The argument "goals" needs a list of goal texts');
    expect(store.get(task.id)?.goals.map((goal) => goal.text)).to.deep.equal(['The tests pass']);
    // An empty list still clears the checklist.
    const cleared = await createTasksTool(deps).run({ action: 'goals', id: task.id, goals: [] });
    expect(cleared.text).to.contain('holds 0 goals');
    expect(store.get(task.id)?.goals).to.deep.equal([]);
  });

  it('refuses a token cap under the smallest cap a record takes, and takes that smallest cap', async () => {
    const tool = createTasksTool(deps);
    let message = '';
    try {
      await tool.run({ action: 'create', title: 'Small budget', maxTokens: 10_000 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // A small cap sits at the wrap-up reserve from the first round, so the create refuses it.
    expect(message).to.contain('The argument "maxTokens" needs 40000 or more');
    expect(store.list()).to.have.lengthOf(0);
    await tool.run({ action: 'create', title: 'Full budget', maxTokens: 40_000 });
    expect(store.list().find((record) => record.title === 'Full budget')?.maxTokens).to.equal(40_000);
    // The round budget takes its own minimum.
    message = '';
    try {
      await tool.run({ action: 'create', title: 'Few rounds', maxTurns: 2 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('The argument "maxTurns" needs 4 or more');
    expect(store.list()).to.have.lengthOf(1);
    await tool.run({ action: 'create', title: 'Four rounds', maxTurns: 4 });
    expect(store.list().find((record) => record.title === 'Four rounds')?.maxTurns).to.equal(4);
  });

  it('names the parent a create misses, and refuses a step of a plan without text', async () => {
    const tool = createTasksTool(deps);
    let message = '';
    try {
      await tool.run({ action: 'create', title: 'Orphan', parentTaskId: 'no-such-parent' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('The parent task no-such-parent matches no record');
    const task = (await store.create(draft('Planned')))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    message = '';
    try {
      await tool.run({ action: 'plan', id: task.id, steps: ['Read', ''] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('Every step of the plan needs a text');
    expect(store.get(task.id)?.plan).to.deep.equal([]);
  });

  it('retries a failed task by its short id on the session the call names, and only from its session or its origin chat', async () => {
    const task = (await store.create(draft('Retried')))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 7, 'session-file-7');
    await store.fail(task.id, 'The provider never answered.', 'provider');
    let retriedAs = '';
    deps = {
      ...deps,
      retry: async (id, mode, sessionFileId) => {
        retriedAs = `${id} ${mode} ${sessionFileId ?? '-'}`;
        return 'The task returns to the queue.';
      },
    };
    const retried = await createTasksTool(deps).run({ action: 'retry', id: task.id.slice(0, 8), mode: 'session', sessionFileId: 'session-file-9' });
    expect(retried.text).to.equal('The task returns to the queue.');
    expect(retriedAs).to.equal(`${task.id} session session-file-9`);
    // A chat that neither ran the task nor created it retries nothing.
    let message = '';
    try {
      await createTasksTool({ ...deps, chatId: 8 }).run({ action: 'retry', id: task.id });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('may not retry');
  });
});
