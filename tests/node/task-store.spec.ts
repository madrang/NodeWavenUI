/**
 * Specs for the task store: a create starts a draft, the transition table refuses a forbidden
 * move, a completion waits for the review, a return re-opens the work, a reopen returns a settle
 * to draft, a blockedBy list holds a queued task until its blocker reaches done, the status
 * override of an edit settles or revives a record outside the table, and the records persist
 * across a reload.
 */

import { expect } from 'chai';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../dist/worker/task-store.js';
import { readTaskRecord, taskCanTransition, type TaskRecord } from '../../dist/shared/tasks.js';

/** One store over a fresh temp workspace. */
function freshStore(): { store: TaskStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nvtask-'));
  return { store: new TaskStore(root), root };
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

  it('drops a damaged record through the read guard', () => {
    expect(readTaskRecord({ id: 'x', title: 5 })).to.equal(null);
    expect(readTaskRecord('text')).to.equal(null);
    expect(readTaskRecord(null)).to.equal(null);
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
