/**
 * Specs for the patch store: a write proposes instead of writing, the rolling patch refreshes in
 * place, an approve applies and closes the record, a denial notices the agent, a drifted file
 * conflicts instead of guessing, and the records persist across a reload.
 */

import { expect } from 'chai';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchStore, type PatchNotice } from '../../dist/renderer/patch-store.js';
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
      remove: async () => {
        throw new Error('not used');
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
function freshStore(): { store: PatchStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nvpatch-'));
  installBridge();
  return { store: new PatchStore(root), root };
}

describe('the patch store', () => {
  let root: string;
  let store: PatchStore;
  let notices: PatchNotice[];
  let target: string;

  beforeEach(async () => {
    const fresh = freshStore();
    root = fresh.root;
    store = fresh.store;
    await store.load();
    notices = [];
    store.onNotice((notice) => {
      notices.push(notice);
    });
    target = join(root, 'note.md');
  });

  afterEach(() => {
    globalThis.nodewavenui = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('proposes without writing the file', async () => {
    const record = await store.propose(7, target, '', 'line one\nline two\n');
    expect(record.state).to.equal('pending');
    expect(record.taskId).to.equal(null);
    expect(existsSync(target)).to.equal(false);
  });

  it('refreshes the rolling patch of the same waiting file', async () => {
    const first = await store.propose(7, target, '', 'line one\nline two\n');
    const second = await store.propose(7, target, '', 'line one\nline two changed\nline three\n');
    expect(second.id).to.equal(first.id);
    expect(second.patch).to.include('line three');
    expect(store.listPatches()).to.have.lengthOf(1);
  });

  it('applies on approve and closes the record', async () => {
    const record = await store.propose(7, target, '', 'line one\nline two\n');
    expect(await store.apply(record.id)).to.equal('applied');
    expect(readFileSync(target, 'utf8')).to.equal('line one\nline two\n');
    expect(store.patch(record.id)?.state).to.equal('applied');
  });

  it('opens a fresh record after a review closed the rolling one', async () => {
    const first = await store.propose(7, target, '', 'line one\n');
    await store.apply(first.id);
    const second = await store.propose(7, target, 'line one\n', 'line one\nline two\n');
    expect(second.id).to.not.equal(first.id);
  });

  it('denies without touching the file and notices the agent', async () => {
    writeFileSync(target, 'line one\n');
    const record = await store.propose(7, target, 'line one\n', 'line changed\n');
    await store.deny(record.id);
    expect(readFileSync(target, 'utf8')).to.equal('line one\n');
    expect(store.patch(record.id)?.state).to.equal('denied');
    expect(notices).to.have.lengthOf(1);
    expect(notices[0]?.chatId).to.equal(7);
    expect(notices[0]?.text).to.include('denied');
  });

  it('conflicts when the file drifted under the patch', async () => {
    const record = await store.propose(7, target, 'line one\nline two\n', 'line one changed\nline two\n');
    writeFileSync(target, 'someone rewrote everything here\n');
    expect(await store.apply(record.id)).to.equal('conflicted');
    expect(readFileSync(target, 'utf8')).to.equal('someone rewrote everything here\n');
    expect(store.patch(record.id)?.comment).to.include('drifted');
  });

  it('applies with the offset search after a nearby shift', async () => {
    const record = await store.propose(7, target, 'top\nline two\nline three\n', 'top\nline two\nline three changed\n');
    writeFileSync(target, 'inserted header\ntop\nline two\nline three\n');
    expect(await store.apply(record.id)).to.equal('applied');
    expect(readFileSync(target, 'utf8')).to.equal('inserted header\ntop\nline two\nline three changed\n');
  });

  it('denies with a comment and sends both to the agent', async () => {
    const record = await store.propose(7, target, '', 'proposed\n');
    await store.deny(record.id, 'Keep the original wording.');
    expect(store.patch(record.id)?.state).to.equal('denied');
    expect(store.patch(record.id)?.comment).to.equal('Keep the original wording.');
    expect(notices).to.have.lengthOf(1);
    expect(notices[0]?.text).to.include('Keep the original wording.');
  });

  it('dismisses without any notice to the agent', async () => {
    const record = await store.propose(7, target, '', 'proposed\n');
    await store.dismiss(record.id);
    expect(store.patch(record.id)?.state).to.equal('dismissed');
    expect(store.patch(record.id)?.comment).to.equal(null);
    expect(notices).to.have.lengthOf(0);
  });

  it('restores every record from a reload', async () => {
    const first = await store.propose(7, target, '', 'one\n');
    await store.apply(first.id);
    const second = await store.propose(7, target, 'one\n', 'two\n');
    await store.deny(second.id);
    const reopened = new PatchStore(root);
    await reopened.load();
    expect(reopened.listPatches()).to.have.lengthOf(2);
    expect(reopened.patch(first.id)?.state).to.equal('applied');
    expect(reopened.patch(second.id)?.state).to.equal('denied');
  });

  it('starts, amends, and replaces tasks, and the title names the tab', async () => {
    expect(store.openTaskTitle(7)).to.equal(null);
    await store.setTask(7, 'Fix the build', 'The rail breaks', false);
    expect(store.openTaskTitle(7)).to.equal('Fix the build');
    await store.setTask(7, 'Fix the rail', null, true);
    expect(store.openTaskTitle(7)).to.equal('Fix the rail');
    expect(store.openTask(7)?.description).to.equal('The rail breaks');
    await store.setTask(7, 'Second task', null, false);
    expect(store.openTask(7)?.title).to.equal('Second task');
    const record = await store.propose(7, target, '', 'proposed\n');
    expect(record.taskId).to.equal(store.openTask(7)?.id);
  });

  it('carries the task of a chat over a reload', async () => {
    await store.setTask(7, 'Persisted task', null, false);
    const reopened = new PatchStore(root);
    await reopened.load();
    expect(reopened.openTaskTitle(7)).to.equal('Persisted task');
  });
});
