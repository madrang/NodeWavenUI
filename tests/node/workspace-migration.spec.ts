/**
 * Specs for the data format migration of the workspace: the version compare both stages share, the
 * upgrade of the bound prompt of one session record, and the core stage that rewrites the session
 * files of the chats folder, plain and sealed.
 */

import { expect } from 'chai';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSessionStore } from '../../dist/worker/chat-sessions.js';
import { migrateCoreWorkspaceData, upgradePromptSourceList } from '../../dist/worker/workspace-migration.js';
import { WorkspaceSettingsStore } from '../../dist/storage/settings-store.js';
import type { StorageBackend } from '../../dist/storage/storage.js';
import { base64ToBytes, importRawAesKey, openRecord, sealRecord } from '../../dist/storage/encryption.js';
import { formatStepApplies, formatVersionIsNewer } from '../../dist/shared/workspace-migration.js';

/** One in-memory settings backend, for the chat key of a password workspace. */
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

/** The suite id of the session file envelopes. */
const FILE_SUITE = 'aes-gcm+pbkdf2' as const;

/** The bound prompt of a session from before the source list. A fresh object on every call, because the
 * upgrade changes the record it receives. */
function oldPrompt(): Record<string, unknown> {
  return { sourceId: 'agents-md', title: 'AGENTS.md', text: 'Be terse.' };
}

/** The same prompt after the upgrade. A fresh object on every call. */
function newPrompt(): Record<string, unknown> {
  return { sourceIds: ['agents-md'], title: 'AGENTS.md', text: 'Be terse.' };
}

/** The none prompt from before the source list. A fresh object on every call. */
function oldNonePrompt(): Record<string, unknown> {
  return { sourceId: 'none', title: 'No system prompt', text: '' };
}

/** One session record with test defaults. */
function record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-11-03T10:00:00.000Z',
    entries: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('the version compare of the migration', () => {
  const promptList = { from: '0.4', to: '0.5', description: 'the prompt names the list of its source ids' };
  const agentsMove = { from: '0.3', to: '0.4', description: 'the AGENTS.md file moves into the instructions folder' };

  it('applies a step to every loaded version from the start of its range up to the running version', () => {
    for (const loaded of [undefined, '0.3.0', '0.4.0', '0.4.9']) {
      expect(formatStepApplies(promptList, loaded, '0.5.0'), String(loaded)).to.equal(true);
    }
    for (const loaded of ['0.5.0', '0.5.1', '0.6.0']) {
      expect(formatStepApplies(promptList, loaded, '0.5.0'), loaded).to.equal(false);
    }
  });

  it('applies no step that ends past the running version', () => {
    expect(formatStepApplies(promptList, '0.4.0', '0.4.9')).to.equal(false);
    expect(formatStepApplies(agentsMove, '0.3.0', '0.4.0')).to.equal(true);
    expect(formatStepApplies(agentsMove, '0.4.0', '0.5.0')).to.equal(false);
  });

  it('applies no step to data newer than the app', () => {
    expect(formatVersionIsNewer('0.6.0', '0.5.0')).to.equal(true);
    expect(formatVersionIsNewer('0.5.0', '0.5.0')).to.equal(false);
    expect(formatVersionIsNewer(undefined, '0.5.0')).to.equal(false);
    expect(formatStepApplies(promptList, '0.6.0', '0.5.0')).to.equal(false);
  });
});

describe('the upgrade of the bound prompt of a session record', () => {
  it('turns the one source id into the list, and the none prompt into the empty list', () => {
    const session = record('chat-1', { systemPrompt: oldPrompt() });
    expect(upgradePromptSourceList(session)).to.equal(true);
    expect(session.systemPrompt).to.deep.equal(newPrompt());
    const none = record('chat-2', { systemPrompt: oldNonePrompt() });
    expect(upgradePromptSourceList(none)).to.equal(true);
    expect(none.systemPrompt).to.deep.equal({ sourceIds: [], title: 'No system prompt', text: '' });
  });

  it('drops the one source id of a record that carries the list already', () => {
    const session = record('chat-1', { systemPrompt: { ...oldPrompt(), sourceIds: ['agents-md', 'rules'] } });
    expect(upgradePromptSourceList(session)).to.equal(true);
    expect(session.systemPrompt).to.deep.equal({
      sourceIds: ['agents-md', 'rules'],
      title: 'AGENTS.md',
      text: 'Be terse.',
    });
  });

  it('changes nothing on a record with the list, without a prompt, or with a damaged prompt', () => {
    expect(upgradePromptSourceList(record('chat-1', { systemPrompt: newPrompt() }))).to.equal(false);
    expect(upgradePromptSourceList(record('chat-2'))).to.equal(false);
    expect(upgradePromptSourceList(record('chat-3', { systemPrompt: 'damaged' }))).to.equal(false);
  });
});

describe('the core stage of the migration', () => {
  let root: string;
  let cleanup: () => void;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nvmigration-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
  });

  /** Writes one session file of the plain workspace, and answers the text it wrote. */
  function writeSessionFile(id: string, contents: unknown): string {
    mkdirSync(join(root, 'chats'), { recursive: true });
    const text = `${JSON.stringify(contents, null, 2)}\n`;
    writeFileSync(join(root, 'chats', `${id}.json`), text);
    return text;
  }

  /** Reads the text of one session file. */
  function readSessionFile(id: string): string {
    return readFileSync(join(root, 'chats', `${id}.json`), 'utf-8');
  }

  /** Reads the bound prompt one session file holds. */
  function promptOf(id: string): unknown {
    return (JSON.parse(readSessionFile(id)) as { systemPrompt?: unknown }).systemPrompt;
  }

  it('rewrites every earlier record in the range of the step, and leaves every other file alone', async () => {
    const oldText = writeSessionFile('chat-old', record('chat-old', { systemPrompt: oldPrompt() }));
    writeSessionFile('chat-none', record('chat-none', { systemPrompt: oldNonePrompt() }));
    const currentText = writeSessionFile('chat-current', record('chat-current', { systemPrompt: newPrompt() }));
    const freeText = writeSessionFile('chat-free', record('chat-free'));
    const store = new ChatSessionStore(root, new WorkspaceSettingsStore(new MemoryBackend()), false);
    await store.init();

    await migrateCoreWorkspaceData('0.4.0', '0.5.0', { chatSessions: store });

    expect(readSessionFile('chat-old')).to.not.equal(oldText);
    expect(promptOf('chat-old')).to.deep.equal(newPrompt());
    expect(promptOf('chat-none')).to.deep.equal({ sourceIds: [], title: 'No system prompt', text: '' });
    expect(readSessionFile('chat-current')).to.equal(currentText);
    expect(readSessionFile('chat-free')).to.equal(freeText);
    // The reader refuses no record any more, so the store reads every session.
    const loaded = await store.loadSessions();
    expect(loaded.map((session) => session.id).sort()).to.deep.equal(['chat-current', 'chat-free', 'chat-none', 'chat-old']);
  });

  it('rewrites nothing when the loaded version sits at or past the step', async () => {
    const text = writeSessionFile('chat-old', record('chat-old', { systemPrompt: oldPrompt() }));
    const store = new ChatSessionStore(root, new WorkspaceSettingsStore(new MemoryBackend()), false);
    await store.init();

    await migrateCoreWorkspaceData('0.5.0', '0.5.0', { chatSessions: store });

    expect(readSessionFile('chat-old')).to.equal(text);
    // The reader refuses the record of the earlier version, which no step upgraded.
    expect(await store.loadSessions()).to.deep.equal([]);
  });

  it('opens, upgrades, and seals again the session files of a password workspace', async () => {
    const settings = new WorkspaceSettingsStore(new MemoryBackend());
    const store = new ChatSessionStore(root, settings, true);
    await store.init();
    // One record of the earlier version, sealed with the chat key the store generated.
    const keyRecord = JSON.parse((await settings.loadChatKey()) ?? 'null') as { key: string };
    const key = await importRawAesKey(base64ToBytes(keyRecord.key));
    const fileName = 'chat-old.json';
    mkdirSync(join(root, 'chats'), { recursive: true });
    writeFileSync(join(root, 'chats', fileName), await sealRecord(FILE_SUITE, key, fileName, JSON.stringify(record('chat-old', { systemPrompt: oldPrompt() }))));

    await migrateCoreWorkspaceData(undefined, '0.5.0', { chatSessions: store });

    const sealed = readSessionFile('chat-old');
    expect(sealed.startsWith('{')).to.equal(false);
    const opened = JSON.parse(await openRecord(FILE_SUITE, key, fileName, sealed)) as { systemPrompt?: unknown };
    expect(opened.systemPrompt).to.deep.equal(newPrompt());
    expect((await store.loadSessions())[0]?.systemPrompt).to.deep.equal(newPrompt());
  });

  it(
    'aborts on a record that does not write, and converts every record on the next run',
    async function (this: Mocha.Context) {
      // Root writes a read-only file, so the failed write needs a plain user.
      if (process.getuid?.() === 0) {
        this.skip();
      }
      const oldA = writeSessionFile('chat-a', record('chat-a', { systemPrompt: oldPrompt() }));
      const oldB = writeSessionFile('chat-b', record('chat-b', { systemPrompt: oldPrompt() }));
      const fileA = join(root, 'chats', 'chat-a.json');
      const fileB = join(root, 'chats', 'chat-b.json');
      chmodSync(fileA, 0o444);
      chmodSync(fileB, 0o444);
      const store = new ChatSessionStore(root, new WorkspaceSettingsStore(new MemoryBackend()), false);
      await store.init();

      let failure: unknown;
      try {
        await migrateCoreWorkspaceData('0.4.0', '0.5.0', { chatSessions: store });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.contain('The workspace data did not migrate from 0.4 to 0.5');
      expect(readSessionFile('chat-a')).to.equal(oldA);
      expect(readSessionFile('chat-b')).to.equal(oldB);
      // The reader refuses the records of the earlier version while no step converted them.
      expect(await store.loadSessions()).to.deep.equal([]);

      chmodSync(fileA, 0o644);
      chmodSync(fileB, 0o644);
      await migrateCoreWorkspaceData('0.4.0', '0.5.0', { chatSessions: store });
      expect(promptOf('chat-a')).to.deep.equal(newPrompt());
      expect(promptOf('chat-b')).to.deep.equal(newPrompt());
    },
  );
});
