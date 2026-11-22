/**
 * Specs for the file tool permissions: every write proposes without a card, an outside read
 * asks one card, a deny rule refuses, an allow rule reads free, the workspace config files
 * refuse without a rule, the pending patch overlays the reads, and the read-first gate holds
 * until the chat reads the file.
 */

import { expect } from 'chai';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTools, type FileToolDeps } from '../../dist/renderer/file-tools.js';
import { PatchStore } from '../../dist/worker/patch-store.js';
import type { AgentTool } from '../../dist/renderer/agent-tools.js';
import type { NodeWavenBridge } from '../../dist/shared/bridge.js';
import type { PathRule } from '../../dist/shared/permissions.js';

/** One recorded permission call of the fake gate. */
interface RecordedCheck {
  action: string;
  path: string;
}

/** Installs the bridge fs slice over real files. */
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

describe('the file tool permissions', () => {
  let root: string;
  let outside: string;
  let checks: RecordedCheck[];
  let rules: readonly PathRule[];
  let store: PatchStore;
  let files: AgentTool;
  let write: AgentTool;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nvfiles-'));
    outside = mkdtempSync(join(tmpdir(), 'nvoutside-'));
    installBridge();
    checks = [];
    rules = [];
    store = new PatchStore(root);
    await store.load();
    const deps: FileToolDeps = {
      check: {
        check: async (_principal, action, target, _detail, _source) => {
          checks.push({ action, path: target.path });
        },
      },
      workspacePath: root,
      chatId: 3,
      sessionFileId: 'spec-session',
      source: 'chat-agent:3',
      store,
      pathRules: () => rules,
    };
    const tools = createFileTools(deps);
    files = tools.find((tool) => tool.name === 'files')!;
    write = tools.find((tool) => tool.name === 'write')!;
  });

  afterEach(() => {
    globalThis.nodewavenui = undefined;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('proposes a workspace write without a card', async () => {
    const output = await write.run({ action: 'write', path: 'inside.md', text: 'one\n' });
    expect(checks).to.deep.equal([]);
    expect(output.text).to.include('waits for review');
    expect(store.listPatches()).to.have.lengthOf(1);
    expect(existsSync(join(root, 'inside.md'))).to.equal(false);
  });

  it('proposes a patch for a write outside the workspace without a card', async () => {
    const target = join(outside, 'agent-test.md');
    const output = await write.run({ action: 'write', path: target, text: 'outside\n' });
    expect(checks).to.deep.equal([]);
    expect(output.text).to.include('waits for review');
    expect(store.listPatches()).to.have.lengthOf(1);
    expect(existsSync(target)).to.equal(false);
  });

  it('asks one read card for a read outside the workspace', async () => {
    const target = join(outside, 'note.txt');
    writeFileSync(target, 'content');
    await files.run({ action: 'read', path: target });
    expect(checks).to.deep.equal([{ action: 'read', path: target }]);
  });

  it('refuses a write and a read under a deny rule', async () => {
    rules = [{ path: 'secrets', name: '', mode: 'deny' }];
    writeFileSync(join(root, 'secrets'), 'key');
    const writeError = await errorOf(() => write.run({ action: 'write', path: 'secrets', text: 'leak' }));
    const readError = await errorOf(() => files.run({ action: 'read', path: 'secrets' }));
    expect(writeError).to.include('denies every agent write');
    expect(readError).to.include('denies every agent access');
    expect(checks).to.deep.equal([]);
  });

  it('reads free under an allow rule', async () => {
    rules = [{ path: 'docs', name: '', mode: 'allow' }];
    writeFileSync(join(root, 'docs'), 'open data');
    const output = await files.run({ action: 'read', path: 'docs' });
    expect(output.text).to.equal('open data');
    expect(checks).to.deep.equal([]);
  });

  it('refuses the workspace config files without a rule', async () => {
    writeFileSync(join(root, '.nodewavenui-settings.json'), '{"remote-token":"secret"}');
    const readError = await errorOf(() => files.run({ action: 'read', path: '.nodewavenui-settings.json' }));
    const writeError = await errorOf(() => write.run({ action: 'write', path: '.nodewavenui-settings.json', text: '{}' }));
    expect(readError).to.include('holds workspace configuration');
    expect(writeError).to.include('holds workspace configuration');
    expect(checks).to.deep.equal([]);
  });

  it('refuses the remote certificate folder without a rule, and a rule opens it', async () => {
    mkdirSync(join(root, '.nodewavenui-remote'));
    writeFileSync(join(root, '.nodewavenui-remote', 'key.pem'), 'private');
    const refused = await errorOf(() => files.run({ action: 'read', path: '.nodewavenui-remote/key.pem' }));
    expect(refused).to.include('holds workspace configuration');
    rules = [{ path: '.nodewavenui-remote', name: 'Remote certificate', mode: 'allow' }];
    const output = await files.run({ action: 'read', path: '.nodewavenui-remote/key.pem' });
    expect(output.text).to.equal('private');
    expect(checks).to.deep.equal([]);
  });

  it('skips refused paths inside a grep scan', async () => {
    writeFileSync(join(root, 'note.md'), 'needle');
    writeFileSync(join(root, '.nodewavenui-settings.json'), '{"needle":"secret"}');
    const output = await files.run({ action: 'grep', path: root, pattern: 'needle' });
    expect(output.text).to.include('note.md');
    expect(output.text).to.not.include('.nodewavenui-settings.json');
  });

  it('reads a written file back with its pending patch applied', async () => {
    await write.run({ action: 'write', path: 'draft.md', text: 'one\ntwo\n' });
    const output = await files.run({ action: 'read', path: 'draft.md' });
    expect(output.text).to.equal('one\ntwo\n');
    expect(existsSync(join(root, 'draft.md'))).to.equal(false);
  });

  it('stacks a later write on the pending content', async () => {
    await write.run({ action: 'write', path: 'stack.md', text: 'alpha\n' });
    await write.run({ action: 'replace', path: 'stack.md', oldText: 'alpha', newText: 'beta' });
    const output = await files.run({ action: 'read', path: 'stack.md' });
    expect(output.text).to.equal('beta\n');
    const records = store.listPatches().filter((record) => record.path === join(root, 'stack.md'));
    expect(records).to.have.lengthOf(1);
  });

  it('greps and lists the pending files of the chat', async () => {
    await write.run({ action: 'write', path: 'needle.md', text: 'the needle sleeps\n' });
    const grep = await files.run({ action: 'grep', path: root, pattern: 'needle sleeps' });
    expect(grep.text).to.include('needle.md');
    const list = await files.run({ action: 'list', path: root });
    expect(list.text).to.include('needle.md');
    expect(existsSync(join(root, 'needle.md'))).to.equal(false);
  });

  it('keeps the overlay across a restore, keyed on the session file id', async () => {
    // The write runs under chat id 3; the restored chat runs under a new runtime id.
    await write.run({ action: 'write', path: 'restore.md', text: 'first\n' });
    const restoredDeps = {
      check: { check: async () => {} },
      workspacePath: root,
      chatId: 9,
      sessionFileId: 'spec-session',
      source: 'chat-agent:9',
      store,
      pathRules: () => rules,
    };
    const restoredTools = createFileTools(restoredDeps);
    const read = await restoredTools.find((tool) => tool.name === 'files')!.run({ action: 'read', path: 'restore.md' });
    expect(read.text).to.equal('first\n');
    await restoredTools.find((tool) => tool.name === 'write')!.run({ action: 'replace', path: 'restore.md', oldText: 'first', newText: 'second' });
    const records = store.listPatches().filter((record) => record.path === join(root, 'restore.md'));
    expect(records).to.have.lengthOf(1);
    const again = await restoredTools.find((tool) => tool.name === 'files')!.run({ action: 'read', path: 'restore.md' });
    expect(again.text).to.equal('second\n');
  });

  it('holds the read-first gate until the chat reads the file', async () => {
    const path = join(root, 'existing.md');
    writeFileSync(path, 'current text');
    const gateError = await errorOf(() => write.run({ action: 'write', path, text: 'new text' }));
    expect(gateError).to.include('never read');
    await files.run({ action: 'read', path });
    await write.run({ action: 'write', path, text: 'new text' });
    expect(store.listPatches()).to.have.lengthOf(1);
  });
});

/** Reads the message of the error one call throws, or null when it passes. */
async function errorOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
