/**
 * Specs for the task template store: a record saves as a template that keeps its brief, its
 * checklist, its plan, and its category. The templates persist across a reload, a short id
 * resolves one, and a removal leaves the tasks that came from it alone.
 */

import { expect } from 'chai';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../dist/worker/task-store.js';
import { TaskTemplateStore } from '../../dist/worker/task-templates.js';

describe('the task template store', () => {
  let root: string;
  let tasks: TaskStore;
  let templates: TaskTemplateStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nvtemplate-'));
    tasks = new TaskStore(root);
    await tasks.load();
    templates = new TaskTemplateStore(root);
    await templates.load();
  });

  it('saves a record as a template, and the templates read after a reload', async () => {
    const record = (await tasks.create({
      title: 'Cleanup',
      description: 'Clean the build folders.',
      goal: 'The tree builds again.',
      goals: ['The build passes'],
      plan: ['List the folders', 'Remove them'],
      category: 'Chores',
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    }))!;
    const template = await templates.save(record);
    // The template keeps the brief of the record. Its checklist and its plan start fresh as texts.
    expect(template).to.include({
      title: 'Cleanup',
      description: 'Clean the build folders.',
      goal: 'The tree builds again.',
      category: 'Chores',
    });
    expect(template.goals).to.deep.equal(['The build passes']);
    expect(template.plan).to.deep.equal(['List the folders', 'Remove them']);
    // The record stays as it is.
    expect(tasks.get(record.id)?.status).to.equal('draft');
    const reloaded = new TaskTemplateStore(root);
    await reloaded.load();
    expect(reloaded.list().map((candidate) => candidate.id)).to.deep.equal([template.id]);
    // A short id resolves the template, and a removal empties the folder.
    expect(reloaded.resolve(template.id.slice(0, 8))?.id).to.equal(template.id);
    expect(reloaded.resolve('no-such-template')).to.equal(null);
    await reloaded.remove(template.id);
    expect(reloaded.list()).to.deep.equal([]);
  });

  it('drops a damaged file and a file of another name, and refuses a short id that matches several', async () => {
    await mkdirSync(join(root, 'templates'), { recursive: true });
    const file = (id: string): string => join(root, 'templates', `task-template-${id}.json`);
    writeFileSync(file('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), JSON.stringify({ id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'First', createdAt: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(file('11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), JSON.stringify({ id: '11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Second', createdAt: '2026-01-02T00:00:00.000Z' }));
    // A damaged file, a file whose name names another id, and a file of another kind drop out.
    writeFileSync(file('22222222-cccc-4ccc-8ccc-cccccccccccc'), '{ not json');
    writeFileSync(file('33333333-dddd-4ddd-8ddd-dddddddddddd'), JSON.stringify({ id: 'other-id', title: 'Misnamed', createdAt: '2026-01-03T00:00:00.000Z' }));
    writeFileSync(join(root, 'templates', 'notes.txt'), 'not a template');
    const store = new TaskTemplateStore(root);
    await store.load();
    // The list reads newest first.
    expect(store.list().map((template) => template.title)).to.deep.equal(['Second', 'First']);
    // A short id that matches several names none, and a longer one names one.
    expect(store.resolve('11111111')).to.equal(null);
    expect(store.resolve('11111111-b')?.title).to.equal('Second');
    // The removal of a template that is not there changes nothing.
    await store.remove('no-such-template');
    expect(store.list()).to.have.lengthOf(2);
  });
});
