/**
 * Specs for the file tool permissions: a workspace write proposes without a card, an outside
 * write and an outside read each ask one card, a deny rule refuses, an allow rule reads free,
 * and the read-first gate holds until the chat reads the file.
 */

import { expect } from 'chai';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTools, type FileToolDeps } from '../../dist/renderer/file-tools.js';
import { PatchStore } from '../../dist/renderer/patch-store.js';
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

  it('asks one propose card for a write outside the workspace', async () => {
    const target = join(outside, 'agent-test.md');
    await write.run({ action: 'write', path: target, text: 'outside\n' });
    expect(checks).to.deep.equal([{ action: 'propose', path: target }]);
    expect(store.listPatches()).to.have.lengthOf(1);
  });

  it('asks one read card for a read outside the workspace', async () => {
    const target = join(outside, 'note.txt');
    writeFileSync(target, 'content');
    await files.run({ action: 'read', path: target });
    expect(checks).to.deep.equal([{ action: 'read', path: target }]);
  });

  it('refuses a write and a read under a deny rule', async () => {
    rules = [{ path: 'secrets', mode: 'deny' }];
    writeFileSync(join(root, 'secrets'), 'key');
    const writeError = await errorOf(() => write.run({ action: 'write', path: 'secrets', text: 'leak' }));
    const readError = await errorOf(() => files.run({ action: 'read', path: 'secrets' }));
    expect(writeError).to.include('denies every agent write');
    expect(readError).to.include('denies every agent access');
    expect(checks).to.deep.equal([]);
  });

  it('reads free under an allow rule', async () => {
    rules = [{ path: 'docs', mode: 'allow' }];
    writeFileSync(join(root, 'docs'), 'open data');
    const output = await files.run({ action: 'read', path: 'docs' });
    expect(output.text).to.equal('open data');
    expect(checks).to.deep.equal([]);
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
