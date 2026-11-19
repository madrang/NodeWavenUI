/**
 * Specs for the read tool: the harness scheme serves the folder listing, the live known-paths
 * document, and the shipped documents; the file scheme serves workspace files after the gate and
 * refuses outside paths; the storage scheme serves shared records; every other scheme reaches the
 * MCP resource surface.
 */

import { expect } from 'chai';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadTool, type AgentToolDeps } from '../../dist/renderer/agent-tools.js';
import { KNOWN_PATHS_URI } from '../../dist/renderer/doc-resources.js';
import type { PathRule } from '../../dist/shared/permissions.js';
import type { NodeWavenBridge } from '../../dist/shared/bridge.js';

/** Installs the bridge fs slice of the workspace page over real files. */
function installBridge(): void {
  globalThis.nodewavenui = {
    fs: {
      list: async (directory: string) => readdirSync(directory),
      readText: async (path: string) => readFileSync(path, 'utf-8'),
      readData: async () => {
        throw new Error('not used');
      },
      writeText: async () => {
        throw new Error('not used');
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

/** One recorded permission check of the stub gate. */
interface RecordedCheck {
  readonly action: string;
  readonly path: string;
  readonly preauthorized: boolean;
}

describe('the read tool', () => {
  let root: string;
  let checks: RecordedCheck[];
  let rules: readonly PathRule[];
  let mcpUris: string[];
  let tool: ReturnType<typeof createReadTool>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nvread-'));
    installBridge();
    writeFileSync(join(root, 'note.md'), 'the note text');
    checks = [];
    rules = [];
    mcpUris = [];
    const deps = {
      gate: {
        check: async (
          _principal: string,
          action: string,
          target: { kind: string; path?: string },
          _detail: string,
          _source?: string | null,
          preauthorized?: boolean,
        ) => {
          checks.push({ action, path: target.path ?? target.kind, preauthorized: preauthorized === true });
        },
      },
      mcpClients: {
        readResource: async (uri: string) => {
          mcpUris.push(uri);
          return `resource of ${uri}`;
        },
      },
      workspacePath: root,
      storageShares: {
        readKey: async (storageId: string, key: string) => `value of ${storageId}/${key}`,
      },
      toolRules: () => [],
      source: 'chat:1',
      chatId: 1,
      patchStore: { propose: async () => {
        throw new Error('not used');
      } },
      pathRules: () => rules,
    } as unknown as AgentToolDeps;
    tool = createReadTool(deps);
  });

  it('needs a uri string', async () => {
    const error = await errorOf(() => tool.run({}));
    expect(error).to.include('uri');
  });

  it('serves the live known-paths document from the path rules', async () => {
    rules = [{ path: 'src', name: 'Source', mode: 'allow' }];
    const output = await tool.run({ uri: KNOWN_PATHS_URI });
    expect(output.text).to.include('**Source** — `src` — allow');
    expect(checks).to.deep.equal([]);
  });

  it('lists the harness root folder with documents and subfolders', async () => {
    const output = await tool.run({ uri: 'harness:///nodewavenui/' });
    expect(output.text).to.contain('# harness:///nodewavenui/');
    expect(output.text).to.contain('overview.md');
    expect(output.text).to.contain('known-paths.md');
    expect(checks).to.deep.equal([]);
  });

  it('serves a shipped harness document', async () => {
    const originalFetch = globalThis.fetch;
    const stub = async () => ({ ok: true, text: async () => 'the overview body' });
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const output = await tool.run({ uri: 'harness:///nodewavenui/overview.md' });
      expect(output.text).to.equal('the overview body');
      expect(checks).to.deep.equal([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses an unknown harness document and names the valid URIs', async () => {
    const error = await errorOf(() => tool.run({ uri: 'harness:///nodewavenui/nope.md' }));
    expect(error).to.include('No harness document matches');
    expect(error).to.include('overview.md');
  });

  it('reads a workspace file through the gate', async () => {
    const output = await tool.run({ uri: `file://${root}/note.md` });
    expect(output.text).to.equal('the note text');
    expect(checks).to.deep.equal([{ action: 'read', path: join(root, 'note.md'), preauthorized: false }]);
  });

  it('passes the preauthorized flag under an allow rule on the read tool', async () => {
    const deps = {
      gate: {
        check: async (
          _principal: string,
          action: string,
          target: { path?: string },
          _detail: string,
          _source?: string | null,
          preauthorized?: boolean,
        ) => {
          checks.push({ action, path: target.path ?? '', preauthorized: preauthorized === true });
        },
      },
      mcpClients: { readResource: async (uri: string) => uri },
      workspacePath: root,
      storageShares: { readKey: async () => null },
      toolRules: () => [{ resource: 'tool', principal: 'agent', actions: ['read'], effect: 'allow', enabled: true }],
      source: 'chat:1',
      chatId: 1,
      patchStore: {},
      pathRules: () => [],
    } as unknown as AgentToolDeps;
    const allowed = createReadTool(deps);
    const output = await allowed.run({ uri: `file://${root}/note.md` });
    expect(output.text).to.equal('the note text');
    expect(checks).to.deep.equal([{ action: 'read', path: join(root, 'note.md'), preauthorized: true }]);
  });

  it('refuses a file outside the workspace before any check', async () => {
    const error = await errorOf(() => tool.run({ uri: 'file:///etc/passwd' }));
    expect(error).to.include('outside the workspace');
    expect(checks).to.deep.equal([]);
  });

  it('serves a storage record of a shared storage', async () => {
    const output = await tool.run({ uri: 'storage://json-file/theme' });
    expect(output.text).to.equal('value of json-file/theme');
    expect(checks).to.deep.equal([]);
  });

  it('refuses a malformed storage URI', async () => {
    const error = await errorOf(() => tool.run({ uri: 'storage://json-file' }));
    expect(error).to.include('storage://<storageId>/<key>');
  });

  it('sends every other scheme to the MCP resource surface', async () => {
    const output = await tool.run({ uri: 'obsidian://note' });
    expect(output.text).to.equal('resource of obsidian://note');
    expect(mcpUris).to.deep.equal(['obsidian://note']);
  });
});

/** Reads the message of one throwing call. */
async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(no error)';
}
