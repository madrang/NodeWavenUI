/**
 * Specs for the plugin folder system: the manifest guard, the scan, the digest, and the integrity gate.
 */

import { expect } from 'chai';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { PluginManager, type PluginDescriptor } from '../../dist/plugins.js';
import {
  hashPluginFolder,
  isPluginFolderManifest,
  PluginFolderController,
  scanPluginFolders,
  type PluginFolderFs,
} from '../../dist/renderer/plugin-folders.js';

/** The real Node fs stands in for the NW.js slice the app reads through. */
const fs = nodeFs as unknown as PluginFolderFs;

/** One scratch app root with a plugins folder, removed after the test. */
function scratchAppRoot(): { root: string; cleanup: () => void } {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeFs.realpathSync(nodeOs.tmpdir()), 'plugin-folders-'));
  nodeFs.mkdirSync(nodePath.join(root, 'plugins'), { recursive: true });
  return { root, cleanup: () => nodeFs.rmSync(root, { recursive: true, force: true }) };
}

function writePlugin(root: string, folder: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  const folderPath = nodePath.join(root, 'plugins', folder);
  nodeFs.mkdirSync(folderPath, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folderPath, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    const filePath = nodePath.join(folderPath, name);
    nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
    nodeFs.writeFileSync(filePath, contents);
  }
}

describe('the manifest guard', () => {
  it('accepts a full manifest and a minimal one', () => {
    expect(
      isPluginFolderManifest({ id: 'selftest', name: 'Self Test', entry: 'index.js', version: '0.1.0', description: 'Runs the specs.' }),
    ).to.equal(true);
    expect(isPluginFolderManifest({ id: 'selftest', name: 'Self Test', entry: 'index.js' })).to.equal(true);
  });

  it('rejects broken shapes and unsafe entry paths', () => {
    expect(isPluginFolderManifest(null)).to.equal(false);
    expect(isPluginFolderManifest({ id: '', name: 'x', entry: 'index.js' })).to.equal(false);
    expect(isPluginFolderManifest({ id: 'x', name: '', entry: 'index.js' })).to.equal(false);
    expect(isPluginFolderManifest({ id: 'x', name: 'x', entry: '' })).to.equal(false);
    expect(isPluginFolderManifest({ id: 'x', name: 'x', entry: '../escape.js' })).to.equal(false);
    expect(isPluginFolderManifest({ id: 'x', name: 'x', entry: '/etc/passwd' })).to.equal(false);
    expect(isPluginFolderManifest({ id: 'x', name: 'x', entry: 'index.js', version: 1 })).to.equal(false);
  });
});

describe('the folder scan', () => {
  it('accepts manifest folders and skips the rest with a reason', () => {
    const { root, cleanup } = scratchAppRoot();
    try {
      writePlugin(root, 'selftest', { id: 'selftest', name: 'Self Test', entry: 'index.js' }, { 'index.js': 'module.exports = {};' });
      writePlugin(root, 'broken', { id: 'broken' });
      nodeFs.mkdirSync(nodePath.join(root, 'plugins', 'no-manifest'), { recursive: true });
      const scan = scanPluginFolders(root, fs);
      expect(scan.plugins).to.have.lengthOf(1);
      expect(scan.plugins[0]?.manifest.id).to.equal('selftest');
      expect(scan.plugins[0]?.manifest.entry).to.equal('index.js');
      const skipped = scan.skipped.map((entry) => entry.folder).sort();
      expect(skipped).to.deep.equal(['broken', 'no-manifest']);
    } finally {
      cleanup();
    }
  });

  it('reports an empty scan when the plugins folder is missing', () => {
    const root = nodeFs.mkdtempSync(nodePath.join(nodeFs.realpathSync(nodeOs.tmpdir()), 'plugin-empty-'));
    try {
      const scan = scanPluginFolders(root, fs);
      expect(scan.plugins).to.deep.equal([]);
      expect(scan.skipped).to.deep.equal([]);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the folder digest', () => {
  it('is stable for the same content and changes with the content or the path', async () => {
    const { root, cleanup } = scratchAppRoot();
    try {
      writePlugin(root, 'selftest', { id: 'selftest', name: 'Self Test', entry: 'index.js' }, { 'index.js': 'a', 'assets/x.txt': 'b' });
      const folderPath = nodePath.join(root, 'plugins', 'selftest');
      const first = await hashPluginFolder(folderPath, fs);
      expect(await hashPluginFolder(folderPath, fs)).to.equal(first);
      nodeFs.writeFileSync(nodePath.join(folderPath, 'index.js'), 'b');
      expect(await hashPluginFolder(folderPath, fs)).to.not.equal(first);
    } finally {
      cleanup();
    }
  });

  it('is independent of the write order of the files', async () => {
    const firstRoot = scratchAppRoot();
    const secondRoot = scratchAppRoot();
    try {
      writePlugin(firstRoot.root, 'p', { id: 'p', name: 'P', entry: 'index.js' }, { 'a.txt': 'one', 'b/c.txt': 'two' });
      writePlugin(secondRoot.root, 'p', { id: 'p', name: 'P', entry: 'index.js' }, { 'b/c.txt': 'two', 'a.txt': 'one' });
      const first = await hashPluginFolder(nodePath.join(firstRoot.root, 'plugins', 'p'), fs);
      const second = await hashPluginFolder(nodePath.join(secondRoot.root, 'plugins', 'p'), fs);
      expect(second).to.equal(first);
    } finally {
      firstRoot.cleanup();
      secondRoot.cleanup();
    }
  });
});

/** A manager stub that records every load as one loaded plugin, so the spec runs without the NW.js require. */
function recordingManager(loaded: PluginDescriptor[]): PluginManager {
  return new (class extends PluginManager {
    override async loadPlugin(): Promise<void> {
      loaded.push({ id: 'selftest', setup: () => {} });
    }

    override listPlugins(): readonly PluginDescriptor[] {
      return loaded;
    }
  })();
}

describe('the integrity gate', () => {
  it('resets an enabled plugin to disabled when the digest changed', async () => {
    const { root, cleanup } = scratchAppRoot();
    const stored: Record<string, { enabled: boolean; digest?: string }> = {};
    const controller = new PluginFolderController(
      new PluginManager(),
      { load: async () => ({ ...stored }), save: async (record) => { Object.assign(stored, record); } },
      root,
      fs,
    );
    try {
      writePlugin(root, 'selftest', { id: 'selftest', name: 'Self Test', entry: 'index.js' }, { 'index.js': 'module.exports = {};' });
      stored['selftest'] = { enabled: true, digest: '0000' };
      await controller.initialize();
      expect(stored['selftest']?.enabled).to.equal(false);
      expect(stored['selftest']?.digest).to.equal(undefined);
      const state = controller.list().find((entry) => entry.id === 'selftest');
      expect(state?.status).to.equal('reset');
      expect(state?.enabled).to.equal(false);
      // The reset state carries the stored digest beside the digest of the changed folder.
      expect(state?.previousDigest).to.equal('0000');
      expect(state?.digest).to.match(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });

  it('shows the calculated digest of a folder that never enabled', async () => {
    const { root, cleanup } = scratchAppRoot();
    const stored: Record<string, { enabled: boolean; digest?: string }> = {};
    const controller = new PluginFolderController(
      new PluginManager(),
      { load: async () => ({ ...stored }), save: async (record) => { Object.assign(stored, record); } },
      root,
      fs,
    );
    try {
      writePlugin(root, 'selftest', { id: 'selftest', name: 'Self Test', entry: 'index.js' }, { 'index.js': 'module.exports = {};' });
      await controller.initialize();
      const state = controller.list().find((entry) => entry.id === 'selftest');
      expect(state?.status).to.equal('disabled');
      // A disabled row carries only the calculated digest of the current content.
      expect(state?.digest).to.match(/^[0-9a-f]{64}$/);
      expect(state?.previousDigest).to.equal(undefined);
    } finally {
      cleanup();
    }
  });

  it('reports a failed load for a matching digest, and keeps the flag for the next start', async () => {
    const { root, cleanup } = scratchAppRoot();
    const stored: Record<string, { enabled: boolean; digest?: string }> = {};
    const controller = new PluginFolderController(
      new PluginManager(),
      { load: async () => ({ ...stored }), save: async (record) => { Object.assign(stored, record); } },
      root,
      fs,
    );
    try {
      writePlugin(root, 'selftest', { id: 'selftest', name: 'Self Test', entry: 'index.js' }, { 'index.js': 'module.exports = {};' });
      const digest = await hashPluginFolder(nodePath.join(root, 'plugins', 'selftest'), fs);
      stored['selftest'] = { enabled: true, digest };
      // Bare Node carries no NW.js require global, so the load itself fails and reports the failure.
      await controller.initialize();
      const state = controller.list().find((entry) => entry.id === 'selftest');
      expect(state?.status).to.equal('failed');
      expect(state?.enabled).to.equal(true);
    } finally {
      cleanup();
    }
  });
});

describe('the enable switch', () => {
  it('re-enables a disabled plugin within one session without loading it a second time', async () => {
    const { root, cleanup } = scratchAppRoot();
    const stored: Record<string, { enabled: boolean; digest?: string }> = {};
    const loaded: PluginDescriptor[] = [];
    const controller = new PluginFolderController(
      recordingManager(loaded),
      { load: async () => ({ ...stored }), save: async (record) => { Object.assign(stored, record); } },
      root,
      fs,
    );
    try {
      writePlugin(root, 'selftest', { id: 'selftest', name: 'Self Test', entry: 'index.js' }, { 'index.js': 'module.exports = {};' });
      await controller.setEnabled('selftest', true);
      expect(loaded).to.have.lengthOf(1);
      expect(stored['selftest']?.enabled).to.equal(true);
      expect(stored['selftest']?.digest).to.be.a('string');
      await controller.setEnabled('selftest', false);
      expect(stored['selftest']?.enabled).to.equal(false);
      expect(controller.list().find((entry) => entry.id === 'selftest')?.digest).to.match(/^[0-9a-f]{64}$/);
      // The disable unloaded nothing, so the re-enable stores the flag without a second load.
      await controller.setEnabled('selftest', true);
      expect(loaded).to.have.lengthOf(1);
      expect(stored['selftest']?.enabled).to.equal(true);
      const state = controller.list().find((entry) => entry.id === 'selftest');
      expect(state?.status).to.equal('loaded');
      expect(state?.digest).to.match(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });
});
