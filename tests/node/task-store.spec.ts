/**
 * Specs for the task store: a create starts a draft, the transition table refuses a forbidden
 * move, a completion waits for the review, a return re-opens the work, a blockedBy list holds a
 * queued task until its blocker reaches done, and the records persist across a reload.
 */

import { expect } from 'chai';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../dist/renderer/task-store.js';
import { readTaskRecord, type TaskRecord } from '../../dist/shared/tasks.js';
import type { NodeWavenBridge } from '../../dist/shared/bridge.js';

/** Installs the bridge fs slice of the workspace page over real files. */
function installBridge(): void {
  globalThis.nodewavenui = {
    fs: {
      list: async (directory: string) => readdirSync(directory),
      readText: async (path: string) => readFileSync(path, 'utf8'),
      readData: async () => {
        throw new Error('not used');
      },
      writeText: async (path: string, text: string) => {
        writeFileSync(path, text);
      },
      writeData: async () => {
        throw new Error('not used');
      },
      makeDirectory: async (path: string) => {
        mkdirSync(path, { recursive: true });
      },
      remove: async (path: string) => {
        rmSync(path, { recursive: true, force: true });
      },
      rename: async () => {
        throw new Error('not used');
      },
      stat: async (path: string) => {
        if (!existsSync(path)) {
          return null;
        }
        return { exists: true, directory: statSync(path).isDirectory() };
      },
    },
  } as unknown as NodeWavenBridge;
}

/** One store over a fresh temp workspace, with the bridge installed. */
function freshStore(): { store: TaskStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nvtask-'));
  installBridge();
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
    installBridge();
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
    installBridge();
    await reloaded.load();
    expect(reloaded.get(task.id)?.title).to.equal('Settled words');
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
    installBridge();
    await reloaded.load();
    expect(reloaded.get(task.id)).to.equal(null);
  });
});
