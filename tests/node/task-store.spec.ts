/**
 * Specs for the task store: a create starts a draft, the transition table refuses a forbidden
 * move, a completion waits for the review, a return re-opens the work, a reopen returns a settle
 * to draft, a blockedBy list holds a queued task until its blocker reaches done, a blocker that
 * fails, cancels, or leaves cancels its queued children, the status override of an edit settles or
 * revives a record outside the table, and the records persist across a reload.
 */

import { expect } from 'chai';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type TaskCreateInput } from '../../dist/worker/task-store.js';
import { readTaskRecord, taskBudgetState, taskCanTransition, type TaskRecord } from '../../dist/shared/tasks.js';

/** One store over a fresh temp workspace. */
function freshStore(): { store: TaskStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nvtask-'));
  return { store: new TaskStore(root), root };
}

/** One record of the specs: a draft of the user, with no brief and no goal. */
function draftLike(title: string): TaskCreateInput {
  return { title, description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] };
}

describe('the task store', () => {
  let root: string;
  let store: TaskStore;
  let settles: TaskRecord[];

  beforeEach(async () => {
    const fresh = freshStore();
    root = fresh.root;
    store = fresh.store;
    await store.load();
    settles = [];
    store.onSettle((task) => {
      settles.push(task);
    });
  });

  it('starts a create as a draft and persists it across a reload', async () => {
    const task = (await store.create({
      title: 'Port the launcher',
      description: 'Move the wizard to the new shell.',
      goal: 'The wizard opens from the launcher.',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    expect(task.status).to.equal('draft');
    const reloaded = new TaskStore(root);
    await reloaded.load();
    const restored = reloaded.get(task.id);
    expect(restored?.title).to.equal('Port the launcher');
    expect(restored?.goal).to.equal('The wizard opens from the launcher.');
    expect(restored?.status).to.equal('draft');
  });

  it('resolves a record by the start of its id, and refuses an ambiguous start', async () => {
    const first = (await store.create({ title: 'First', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    const second = (await store.create({ title: 'Second', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    // The two ids share a start of at least one character.
    let shared = '';
    while (first.id[shared.length] === second.id[shared.length] && first.id[shared.length]) {
      shared += first.id[shared.length];
    }
    expect(store.resolve(first.id.slice(0, shared.length + 1))?.id).to.equal(first.id);
    expect(store.resolve(shared)).to.equal(null);
    expect(store.resolve(first.id)?.id).to.equal(first.id);
    expect(store.resolve('no-such-task')).to.equal(null);
    // A create names its parent and its blockers the same way, and keeps the full ids.
    const child = (await store.create({
      title: 'Child',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: first.id.slice(0, 8),
      blockedBy: [second.id.slice(0, 8)],
    }))!;
    expect(child.parentTaskId).to.equal(first.id);
    expect(child.blockedBy).to.deep.equal([second.id]);
  });

  it('refuses a create whose blockedBy list names an unknown task', async () => {
    const task = await store.create({
      title: 'Broken child',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 3,
      parentTaskId: null,
      blockedBy: ['no-such-task'],
    });
    expect(task).to.equal(null);
  });

  it('walks the happy path: dispatch, bind, complete, accept', async () => {
    const task = (await store.create({
      title: 'Write the note',
      description: '',
      goal: 'The note reads.',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const queued = await store.dispatch(task.id, 'new-session', null);
    expect(queued?.status).to.equal('queued');
    expect(queued?.sessionFileId).to.equal(null);
    const running = await store.bindSession(task.id, 7, 'session-file-1');
    expect(running?.status).to.equal('running');
    expect(running?.sessionChatId).to.equal(7);
    const review = await store.complete(task.id, 'The note reads.', 'The file lists it.');
    expect(review?.status).to.equal('review');
    expect(review?.result).to.equal('The note reads.');
    expect(settles.map((entry) => entry.id)).to.deep.equal([task.id]);
    const done = await store.accept(task.id);
    expect(done?.status).to.equal('done');
    expect(settles.length).to.equal(2);
  });

  it('returns a review to running and clears the old result', async () => {
    const task = (await store.create({
      title: 'Draft the plan',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 2,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await store.dispatch(task.id, 'session', 'session-file-2');
    await store.bindSession(task.id, 5, 'session-file-2');
    await store.complete(task.id, 'First summary.', null);
    const returned = await store.returnToSession(task.id);
    expect(returned?.status).to.equal('running');
    expect(returned?.result).to.equal(null);
    expect(returned?.evidence).to.equal(null);
  });

  it('refuses a forbidden transition', async () => {
    const task = (await store.create({
      title: 'Idle',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    expect(await store.complete(task.id, 'Too early.', null)).to.equal(null);
    expect(await store.bindSession(task.id, 1, 'f')).to.equal(null);
    const cancelled = await store.cancel(task.id, 'Not wanted.');
    expect(cancelled?.status).to.equal('cancelled');
    expect(await store.cancel(task.id, 'Twice.')).to.equal(null);
  });

  it('fails a running task on the agent word', async () => {
    const task = (await store.create({
      title: 'Impossible',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 1,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 2, 'session-file-3');
    const failed = await store.fail(task.id, 'The API never answers.');
    expect(failed?.status).to.equal('failed');
    expect(failed?.note).to.equal('The API never answers.');
    expect(settles.length).to.equal(1);
  });

  it('holds a queued child until its blocker reaches done, then hands it to the session queue', async () => {
    const parent = (await store.create({
      title: 'First half',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const child = (await store.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: parent.id,
      blockedBy: [parent.id],
    }))!;
    await store.dispatch(child.id, 'session', 'session-file-4');
    expect(store.ready(child)).to.equal(false);
    expect(store.nextQueuedFor('session-file-4')).to.equal(null);
    await store.dispatch(parent.id, 'new-session', null);
    await store.bindSession(parent.id, 9, 'session-file-5');
    await store.complete(parent.id, 'First half done.', null);
    expect(store.ready(child)).to.equal(false);
    await store.accept(parent.id);
    expect(store.ready(child)).to.equal(true);
    const next = store.nextQueuedFor('session-file-4');
    expect(next?.id).to.equal(child.id);
  });

  it('fails the queued children of a failed blocker, and leaves a draft child alone', async () => {
    const parent = (await store.create({
      title: 'First half',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const child = (await store.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: parent.id,
      blockedBy: [parent.id],
    }))!;
    const grandchild = (await store.create({
      title: 'Third half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: child.id,
      blockedBy: [child.id],
    }))!;
    const draft = (await store.create({
      title: 'Fourth half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 5,
      parentTaskId: parent.id,
      blockedBy: [parent.id],
    }))!;
    await store.dispatch(parent.id, 'new-session', null);
    await store.bindSession(parent.id, 9, 'session-file-5');
    await store.dispatch(child.id, 'session', 'session-file-4');
    await store.dispatch(grandchild.id, 'session', 'session-file-4');
    await store.fail(parent.id, 'The API never answers.');
    // The child never reaches done through its blocker, so it fails with it, and its own queued child fails in turn.
    expect(store.get(child.id)).to.include({ status: 'failed', endCause: 'cascade' });
    expect(store.get(child.id)?.note).to.equal(`The blocker task ${parent.id} failed.`);
    expect(store.get(grandchild.id)).to.include({ status: 'failed', endCause: 'cascade' });
    expect(store.get(grandchild.id)?.note).to.equal(`The blocker task ${child.id} failed.`);
    // The failure of each child reaches the settle listeners after the failure of its blocker.
    expect(settles.map((task) => task.id)).to.deep.equal([parent.id, child.id, grandchild.id]);
    expect(store.nextQueuedFor('session-file-4')).to.equal(null);
    // A draft child keeps its draft: its blocker may come back through a reopen.
    expect(store.get(draft.id)?.status).to.equal('draft');
  });

  it('returns a blocked record to the queue for an answer that waits for a slot', async () => {
    const task = (await store.create({ title: 'Asking', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 9, 'session-file-9');
    await store.block(task.id, 'Which file?');
    const requeued = await store.requeue(task.id);
    // The record waits in the queue for the session that ran it, so the answer can start its turn there.
    expect(requeued).to.include({ status: 'queued', question: null, dispatchMode: 'session', sessionFileId: 'session-file-9' });
    expect(requeued?.blockedAt).to.equal(null);
    expect(await store.requeue(task.id)).to.equal(null);
  });

  it('fails the queued children of a blocker that ends exhausted, timeout, or is set there by hand', async () => {
    const parent = (await store.create({ title: 'First half', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    const child = (await store.create({ title: 'Second half', description: '', goal: '', origin: 'agent', originChatId: 4, parentTaskId: parent.id, blockedBy: [parent.id] }))!;
    await store.dispatch(parent.id, 'new-session', null);
    await store.bindSession(parent.id, 9, 'session-file-5');
    await store.dispatch(child.id, 'session', 'session-file-4');
    await store.endRun(parent.id, 'exhausted', 'token-budget');
    // The blocker did not finish, so its queued child fails with it.
    expect(store.get(child.id)).to.include({ status: 'failed', endCause: 'cascade' });
    expect(store.get(child.id)?.note).to.equal(`The blocker task ${parent.id} ended as exhausted.`);
    const other = (await store.create({ title: 'Other half', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    const otherChild = (await store.create({ title: 'Last half', description: '', goal: '', origin: 'agent', originChatId: 4, parentTaskId: other.id, blockedBy: [other.id] }))!;
    await store.dispatch(other.id, 'new-session', null);
    await store.bindSession(other.id, 9, 'session-file-6');
    await store.dispatch(otherChild.id, 'session', 'session-file-4');
    await store.update(other.id, { status: 'timeout' });
    expect(store.get(otherChild.id)).to.include({ status: 'failed', endCause: 'cascade' });
    expect(store.get(otherChild.id)?.note).to.equal(`The blocker task ${other.id} was set to timeout.`);
  });

  it('cancels the queued children and grandchildren of a cancelled blocker', async () => {
    const parent = (await store.create({
      title: 'First half',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const child = (await store.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: parent.id,
      blockedBy: [parent.id],
    }))!;
    const grandchild = (await store.create({
      title: 'Third half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: child.id,
      blockedBy: [child.id],
    }))!;
    await store.dispatch(parent.id, 'new-session', null);
    await store.bindSession(parent.id, 9, 'session-file-5');
    await store.dispatch(child.id, 'session', 'session-file-4');
    await store.dispatch(grandchild.id, 'session', 'session-file-4');
    await store.cancel(parent.id, 'Called off.');
    expect(store.get(child.id)?.status).to.equal('cancelled');
    expect(store.get(child.id)?.note).to.equal(`The blocker task ${parent.id} was cancelled.`);
    expect(store.get(grandchild.id)?.status).to.equal('cancelled');
    expect(store.get(grandchild.id)?.note).to.equal(`The blocker task ${child.id} was cancelled.`);
  });

  it('cancels the queued children of a removed blocker', async () => {
    const parent = (await store.create({
      title: 'First half',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const child = (await store.create({
      title: 'Second half',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 4,
      parentTaskId: parent.id,
      blockedBy: [parent.id],
    }))!;
    await store.dispatch(parent.id, 'new-session', null);
    await store.dispatch(child.id, 'session', 'session-file-4');
    await store.remove(parent.id);
    expect(store.get(parent.id)).to.equal(null);
    expect(store.get(child.id)?.status).to.equal('cancelled');
    expect(store.get(child.id)?.note).to.equal(`The blocker task ${parent.id} was removed.`);
  });

  it('drops a damaged record through the read guard', () => {
    expect(readTaskRecord({ id: 'x', title: 5 })).to.equal(null);
    expect(readTaskRecord('text')).to.equal(null);
    expect(readTaskRecord(null)).to.equal(null);
  });

  it('charges the rounds of a running record, and ends it as exhausted or timeout with its cause', async () => {
    const task = (await store.create({ title: 'Capped', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [], maxTokens: 5000 }))!;
    // A record that does not run charges nothing.
    expect(await store.charge(task.id, 10, 5)).to.equal(null);
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 3, 'session-file-3');
    expect(typeof store.get(task.id)?.startedAt).to.equal('string');
    // A round tells no listener: the surfaces do not rebuild on every round of a running task.
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    await store.charge(task.id, 1200, 300);
    await store.charge(task.id, 800, 200);
    expect(store.get(task.id)).to.include({ tokensIn: 2000, tokensOut: 500, turns: 2 });
    expect(changes).to.equal(0);
    const ended = await store.endRun(task.id, 'exhausted', 'token-budget');
    // The next change of the record carries the spend to the surfaces.
    expect(changes).to.equal(1);
    expect(ended).to.include({ status: 'exhausted', endCause: 'token-budget' });
    expect(settles.map((record) => record.id)).to.deep.equal([task.id]);
    // A settled record charges nothing more, and no second end lands.
    expect(await store.charge(task.id, 1, 1)).to.equal(null);
    expect(await store.endRun(task.id, 'timeout', 'timeout')).to.equal(null);
    // A record in review still runs its session, so its closing rounds count. They are the last of
    // the run, so they tell the listeners, and the surfaces show the final spend.
    const reviewed = (await store.create({ ...draftLike('Reviewed spend') }))!;
    await store.dispatch(reviewed.id, 'new-session', null);
    await store.bindSession(reviewed.id, 4, 'session-file-4');
    await store.complete(reviewed.id, 'Done.', null);
    const beforeCharge = changes;
    expect((await store.charge(reviewed.id, 900, 100))?.turns).to.equal(1);
    expect(changes).to.equal(beforeCharge + 1);
    // A reopen clears the settle and the run, so a new dispatch starts with a full budget.
    const reopened = await store.reopen(task.id);
    expect(reopened).to.include({ status: 'draft', tokensIn: 0, tokensOut: 0, turns: 0, startedAt: null, endCause: null, maxTokens: 5000 });
  });

  it('keeps the caps of a create, edits or clears them through an update, and reads an old record without them', async () => {
    const task = (await store.create({ title: 'Capped', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [], maxTokens: 5000, maxTurns: 20, timeoutMs: 60000 }))!;
    expect(task).to.include({ maxTokens: 5000, maxTurns: 20, timeoutMs: 60000, endCause: null });
    // A cap the update leaves out keeps its value, and null clears one.
    await store.update(task.id, { maxTokens: null });
    expect(store.get(task.id)).to.include({ maxTokens: null, maxTurns: 20, timeoutMs: 60000 });
    await store.update(task.id, { maxTurns: 40 });
    expect(store.get(task.id)?.maxTurns).to.equal(40);
    // A record of the first shape carries no caps and no spend: it reads as no cap and as zero.
    const old = readTaskRecord({
      id: 'old',
      title: 'Old',
      description: '',
      goal: '',
      origin: 'user',
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      blockedBy: [],
    });
    expect(old).to.include({
      maxTokens: null,
      maxTurns: null,
      timeoutMs: null,
      tokensIn: 0,
      tokensOut: 0,
      turns: 0,
      startedAt: null,
      endCause: null,
    });
  });

  it('names who or what ended the record', async () => {
    const parent = (await store.create({ title: 'First half', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    const child = (await store.create({ title: 'Second half', description: '', goal: '', origin: 'agent', originChatId: 4, parentTaskId: parent.id, blockedBy: [parent.id] }))!;
    await store.dispatch(parent.id, 'new-session', null);
    await store.bindSession(parent.id, 9, 'session-file-5');
    await store.dispatch(child.id, 'session', 'session-file-4');
    await store.fail(parent.id, 'The provider never answered.', 'provider');
    expect(store.get(parent.id)?.endCause).to.equal('provider');
    expect(store.get(child.id)?.endCause).to.equal('cascade');
    const other = (await store.create({ title: 'Other', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    await store.cancel(other.id, null, 'session-closed');
    expect(store.get(other.id)?.endCause).to.equal('session-closed');
    const reviewed = (await store.create({
      title: 'Reviewed',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await store.dispatch(reviewed.id, 'new-session', null);
    await store.bindSession(reviewed.id, 10, 'session-file-6');
    await store.complete(reviewed.id, 'Done.', null);
    expect(store.get(reviewed.id)?.endCause).to.equal(null);
    await store.accept(reviewed.id);
    expect(store.get(reviewed.id)?.endCause).to.equal('user');
  });

  it('keeps the retry count and the fallback chain of a create, and reads an old record without them', async () => {
    const task = (await store.create({
      title: 'Resilient',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      retries: 0,
      fallbacks: [{ providerId: 'account-2', model: 'other-model' }],
    }))!;
    // Zero retries is a count of its own, so it never reads as the default.
    expect(task.retries).to.equal(0);
    expect(task.fallbacks).to.deep.equal([{ providerId: 'account-2', model: 'other-model' }]);
    const plain = (await store.create({
      title: 'Plain',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    expect(plain.retries).to.equal(null);
    expect(plain.fallbacks).to.deep.equal([]);
    const old = readTaskRecord({ id: 'old', title: 'Old', origin: 'user', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', blockedBy: [] });
    expect(old?.retries).to.equal(null);
    expect(old?.fallbacks).to.deep.equal([]);
    // A damaged chain refuses the record.
    expect(readTaskRecord({ ...old, id: 'broken', fallbacks: [{ providerId: 5, model: 'x' }] })).to.equal(null);
  });

  it('orders the queue by priority, then by dispatch', async () => {
    const low = (await store.create({ title: 'Low', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [], priority: 1 }))!;
    const high = (await store.create({ title: 'High', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [], priority: 9 }))!;
    // A create that names no priority reads the default, and one above the maximum reads as the maximum.
    const plain = (await store.create({ title: 'Plain', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [] }))!;
    expect(plain.priority).to.equal(5);
    expect((await store.create({ ...draftLike('Over'), priority: 99 }))!.priority).to.equal(10);
    const later = (await store.create({ title: 'Later', description: '', goal: '', origin: 'user', originChatId: null, parentTaskId: null, blockedBy: [], priority: 9 }))!;
    await store.dispatch(low.id, 'new-session', null);
    await store.dispatch(high.id, 'new-session', null);
    // The dispatch stamps carry milliseconds, so the later dispatch needs a later one.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await store.dispatch(later.id, 'new-session', null);
    expect(store.queued().map((record) => record.id)).to.deep.equal([high.id, later.id, low.id]);
    // An edit moves a record in the queue.
    await store.update(low.id, { priority: 10 });
    expect(store.queued().map((record) => record.id)).to.deep.equal([low.id, high.id, later.id]);
  });

  it('keeps the plan of a create, and replaces it while the record lives', async () => {
    const task = (await store.create({ ...draftLike('Planned'), plan: ['Read the files', 'Sort them'] }))!;
    expect(task.plan).to.deep.equal([
      { text: 'Read the files', state: 'pending' },
      { text: 'Sort them', state: 'pending' },
    ]);
    const updated = await store.setPlan(task.id, [
      { text: 'Read the files', state: 'completed' },
      { text: 'Sort them', state: 'in_progress' },
    ]);
    expect(updated?.plan.map((step) => step.state)).to.deep.equal(['completed', 'in_progress']);
    // An empty list clears the plan, and a settled record keeps the plan it had.
    expect((await store.setPlan(task.id, []))?.plan).to.deep.equal([]);
    await store.cancel(task.id, 'Done by hand.');
    expect(await store.setPlan(task.id, [{ text: 'Late', state: 'pending' }])).to.equal(null);
    // A record of the first shape reads with no plan, and a damaged plan refuses the record.
    const old = readTaskRecord({ id: 'old', title: 'Old', origin: 'user', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', blockedBy: [] });
    expect(old?.plan).to.deep.equal([]);
    expect(readTaskRecord({ ...old, id: 'broken', plan: [{ text: 'Step', state: 'later' }] })).to.equal(null);
  });

  it('holds a completion while a checklist goal stays open, and keeps the proof of a goal', async () => {
    const task = (await store.create({ ...draftLike('Proven'), goals: ['The tests pass', 'The readme reads well'] }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 3, 'session-file-3');
    expect(await store.complete(task.id, 'Done.', null)).to.equal(null);
    const proved = await store.proveGoal(task.id, 0, [{ kind: 'command', command: 'npm test' }]);
    expect(proved?.goals[0]).to.deep.equal({ text: 'The tests pass', met: true, evidence: [{ kind: 'command', command: 'npm test' }] });
    // The second goal still holds the completion back.
    expect(await store.complete(task.id, 'Done.', null)).to.equal(null);
    expect(await store.proveGoal(task.id, 7, [])).to.equal(null);
    await store.proveGoal(task.id, 1, [{ kind: 'patch', id: 12 }]);
    expect((await store.complete(task.id, 'Done.', 'Both proven'))?.status).to.equal('review');
    // A goal that keeps its text at the same place keeps its proof through an edit, and a changed one starts open.
    await store.returnToSession(task.id);
    await store.setGoals(task.id, ['The tests pass', 'The readme reads well', 'A third one']);
    expect(store.get(task.id)?.goals.map((goal) => goal.met)).to.deep.equal([true, true, false]);
    await store.update(task.id, { goals: ['Changed', 'The readme reads well'] });
    expect(store.get(task.id)?.goals.map((goal) => goal.met)).to.deep.equal([false, true]);
    // A reopen opens every goal, so a new run proves them again.
    await store.update(task.id, { status: 'done' });
    await store.reopen(task.id);
    expect(store.get(task.id)?.goals.map((goal) => goal.met)).to.deep.equal([false, false]);
    // A record of the first shape reads with no checklist, and a damaged one refuses the record.
    const old = readTaskRecord({ id: 'old', title: 'Old', origin: 'user', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', blockedBy: [] });
    expect(old?.goals).to.deep.equal([]);
    expect(readTaskRecord({ ...old, id: 'broken', goals: [{ text: 'Goal', met: 'yes' }] })).to.equal(null);
  });

  it('moves a running record to blocked and back, and skips the wait in its clock', async () => {
    const task = (await store.create({ ...draftLike('Asking'), timeoutMs: 60000 }))!;
    // Only a running record blocks.
    expect(await store.block(task.id, 'Which file?')).to.equal(null);
    await store.dispatch(task.id, 'new-session', null);
    const startedAt = Date.parse((await store.bindSession(task.id, 3, 'session-file-3'))?.startedAt ?? '');
    const blocked = await store.block(task.id, 'Which file?');
    expect(blocked).to.include({ status: 'blocked', question: 'Which file?' });
    // The question reaches the settle listeners, like a settle does.
    expect(settles.map((record) => `${record.status}:${record.question}`)).to.deep.equal(['blocked:Which file?']);
    // A blocked record takes no round, no proof, and no completion: the answer comes first.
    expect(await store.charge(task.id, 10, 5)).to.equal(null);
    expect(await store.complete(task.id, 'Done.', null)).to.equal(null);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 8);
    });
    const resumed = await store.unblock(task.id);
    expect(resumed).to.include({ status: 'running', question: null, blockedAt: null });
    // The clock went on from where it stopped.
    expect(Date.parse(resumed?.startedAt ?? '') - startedAt).to.be.at.least(6);
    expect(await store.unblock(task.id)).to.equal(null);
    // A cancelled block clears its question on the next reopen.
    await store.block(task.id, 'Why?');
    await store.cancel(task.id, 'Not needed.');
    await store.reopen(task.id);
    expect(store.get(task.id)).to.include({ status: 'draft', question: null, blockedAt: null });
  });

  it('archives a settled record, restores it, and reads the archive after a reload', async () => {
    const task = (await store.create(draftLike('Put away')))!;
    // A live record never archives.
    expect(await store.archive(task.id)).to.equal(null);
    await store.cancel(task.id, 'Not needed.');
    expect((await store.archive(task.id))?.status).to.equal('cancelled');
    // The record left the live lists and joined the archive, in its own folder.
    expect(store.list().some((record) => record.id === task.id)).to.equal(false);
    expect(store.archived().map((record) => record.id)).to.deep.equal([task.id]);
    expect(existsSync(join(root, 'tasks', `task-${task.id}.json`))).to.equal(false);
    expect(existsSync(join(root, 'archive', `task-${task.id}.json`))).to.equal(true);
    // The archive reads after a reload.
    const reloaded = new TaskStore(root);
    await reloaded.load();
    expect(reloaded.list().some((record) => record.id === task.id)).to.equal(false);
    expect(reloaded.archived().map((record) => record.id)).to.deep.equal([task.id]);
    // A restore brings the record back with the state it left with.
    expect((await reloaded.restore(task.id))?.status).to.equal('cancelled');
    expect(reloaded.list().some((record) => record.id === task.id)).to.equal(true);
    expect(reloaded.archived()).to.deep.equal([]);
    expect(existsSync(join(root, 'tasks', `task-${task.id}.json`))).to.equal(true);
    // An archived record removes from the archive, and nothing else.
    await reloaded.archive(task.id);
    await reloaded.remove(task.id);
    expect(reloaded.archived()).to.deep.equal([]);
    expect(existsSync(join(root, 'archive', `task-${task.id}.json`))).to.equal(false);
  });

  it('reads the budget state of a record against its caps', () => {
    const base = { tokensIn: 0, tokensOut: 0, turns: 0 } as const;
    const of = (caps: object, spend: object): string =>
      taskBudgetState({ ...base, maxTokens: null, maxTurns: null, ...caps, ...spend } as TaskRecord);
    // No cap never binds.
    expect(of({}, { tokensIn: 1_000_000_000, turns: 1_000_000 })).to.equal('run');
    // The turn reserve holds two rounds.
    expect(of({ maxTurns: 10 }, { turns: 7 })).to.equal('run');
    expect(of({ maxTurns: 10 }, { turns: 8 })).to.equal('wrapup');
    expect(of({ maxTurns: 10 }, { turns: 10 })).to.equal('out');
    // The token reserve holds a tenth of the cap, and at least 20 000 tokens.
    expect(of({ maxTokens: 100000 }, { tokensIn: 79000 })).to.equal('run');
    expect(of({ maxTokens: 100000 }, { tokensIn: 80000 })).to.equal('wrapup');
    expect(of({ maxTokens: 100000 }, { tokensIn: 100000 })).to.equal('out');
    expect(of({ maxTokens: 1000 }, { tokensIn: 100 })).to.equal('wrapup');
  });

  it('updates the fields of one record, keeps absent fields, and refuses an empty title', async () => {
    const task = (await store.create({
      title: 'Draft words',
      description: 'First brief.',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const updated = await store.update(task.id, { title: 'Settled words', description: 'Second brief.', goal: 'Reads well.' });
    expect(updated?.title).to.equal('Settled words');
    expect(updated?.description).to.equal('Second brief.');
    expect(updated?.goal).to.equal('Reads well.');
    // An absent field keeps its stored value, and an empty string clears it.
    const partial = await store.update(task.id, { description: 'Third brief.' });
    expect(partial?.title).to.equal('Settled words');
    expect(partial?.description).to.equal('Third brief.');
    expect(partial?.goal).to.equal('Reads well.');
    const cleared = await store.update(task.id, { description: '' });
    expect(cleared?.description).to.equal('');
    expect(await store.update(task.id, { title: '' })).to.equal(null);
    const reloaded = new TaskStore(root);
    await reloaded.load();
    expect(reloaded.get(task.id)?.title).to.equal('Settled words');
  });

  it('reopens a settled record to a draft and clears the settle fields', async () => {
    const task = (await store.create({
      title: 'Second wind',
      description: '',
      goal: '',
      origin: 'agent',
      originChatId: 6,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 6, 'session-file-6');
    await store.complete(task.id, 'Done once.', 'The file shows it.');
    await store.accept(task.id);
    expect(settles.length).to.equal(2);
    const reopened = await store.reopen(task.id);
    expect(reopened?.status).to.equal('draft');
    expect(reopened?.result).to.equal(null);
    expect(reopened?.evidence).to.equal(null);
    expect(reopened?.settledAt).to.equal(null);
    // A revive is no settle, and a live record reopens nothing.
    expect(settles.length).to.equal(2);
    expect(await store.reopen(task.id)).to.equal(null);
    expect(await store.reopen('no-such-task')).to.equal(null);
    await store.dispatch(task.id, 'new-session', null);
    await store.bindSession(task.id, 6, 'session-file-7');
    await store.fail(task.id, 'The second run stopped.');
    expect((await store.reopen(task.id))?.note).to.equal(null);
    const reloaded = new TaskStore(root);
    await reloaded.load();
    expect(reloaded.get(task.id)?.status).to.equal('draft');
  });

  it('sets a status by hand outside the transition table, and a hand settle reaches the listeners', async () => {
    const task = (await store.create({
      title: 'By hand',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    // The table forbids draft to done, and the hand override answers no table.
    expect(taskCanTransition('draft', 'done')).to.equal(false);
    // The listeners receive the live record, so the status is read as each settle fires.
    const heard: string[] = [];
    store.onSettle((record) => {
      heard.push(record.status);
    });
    const done = await store.update(task.id, { status: 'done' });
    expect(done?.status).to.equal('done');
    expect(typeof done?.settledAt).to.equal('string');
    expect(heard).to.deep.equal(['done']);
    // A settle of a settled record is no news.
    const failed = await store.update(task.id, { status: 'failed' });
    expect(failed?.status).to.equal('failed');
    expect(heard).to.deep.equal(['done']);
    // A revive clears the settle fields and fires no settle.
    const revived = await store.update(task.id, { status: 'draft' });
    expect(revived?.status).to.equal('draft');
    expect(revived?.settledAt).to.equal(null);
    expect(heard).to.deep.equal(['done']);
    // The revived record settles again by hand.
    await store.update(task.id, { status: 'cancelled' });
    expect(heard).to.deep.equal(['done', 'cancelled']);
  });

  it('removes one record from memory and from the folder', async () => {
    const task = (await store.create({
      title: 'Gone soon',
      description: '',
      goal: '',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    await store.remove(task.id);
    expect(store.get(task.id)).to.equal(null);
    const reloaded = new TaskStore(root);
    await reloaded.load();
    expect(reloaded.get(task.id)).to.equal(null);
  });
});
