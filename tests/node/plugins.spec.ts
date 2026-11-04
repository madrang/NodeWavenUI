/**
 * Specs for the plugin manager: the registration paths and the shape guards.
 */

import { expect } from 'chai';
import { PluginError, PluginManager } from '../../dist/plugins.js';

describe('the plugin manager', () => {
  it('registers one system prompt source and lists it in order', () => {
    const manager = new PluginManager();
    manager.registerSystemPromptSetup({ id: 'agents-md', label: 'AGENTS.md', build: async () => 'text' });
    manager.registerSystemPromptSetup({ id: 'none', label: 'No system prompt', build: async () => '' });
    expect(manager.listSystemPromptSetups().map((setup) => setup.id)).to.deep.equal(['agents-md', 'none']);
    expect(manager.getSystemPromptSetup('agents-md')?.label).to.equal('AGENTS.md');
    expect(manager.getSystemPromptSetup('missing')).to.equal(undefined);
  });

  it('rejects a setup that breaks the shape', () => {
    const manager = new PluginManager();
    expect(() => manager.registerSystemPromptSetup({ label: 'No id', build: async () => '' })).to.throw(PluginError);
    expect(() => manager.registerSystemPromptSetup({ id: 'x', label: '', build: async () => '' })).to.throw(PluginError);
    expect(() => manager.registerSystemPromptSetup({ id: 'x', label: 'No build' })).to.throw(PluginError);
    expect(() => manager.registerSystemPromptSetup('x')).to.throw(PluginError);
  });

  it('rejects a second setup with the same id', () => {
    const manager = new PluginManager();
    manager.registerSystemPromptSetup({ id: 'agents-md', label: 'AGENTS.md', build: async () => 'text' });
    expect(() => manager.registerSystemPromptSetup({ id: 'agents-md', label: 'Again', build: async () => 'text' })).to.throw(
      PluginError,
      /already registered/,
    );
  });

  it('registers one harness document and rejects a duplicate uri', () => {
    const manager = new PluginManager();
    const doc = {
      uri: 'harness:///nodewavenui/selftest.md',
      file: '/plugins/selftest/selftest.md',
      name: 'selftest',
      description: 'The app self test.',
    };
    manager.registerHarnessDoc(doc);
    expect(manager.listHarnessDocs()).to.deep.equal([doc]);
    expect(() => manager.registerHarnessDoc({ ...doc, name: 'again' })).to.throw(PluginError, /already registered/);
  });

  it('rejects a harness document that takes a reserved built-in uri', () => {
    const manager = new PluginManager(['harness:///nodewavenui/overview.md']);
    expect(() =>
      manager.registerHarnessDoc({ uri: 'harness:///nodewavenui/overview.md', file: '/x', name: 'x', description: 'x' }),
    ).to.throw(PluginError, /built-in/);
    manager.registerHarnessDoc({ uri: 'harness:///nodewavenui/other.md', file: '/x', name: 'x', description: 'x' });
    expect(manager.listHarnessDocs()).to.have.lengthOf(1);
  });

  it('rejects a harness document that breaks the shape', () => {
    const manager = new PluginManager();
    expect(() => manager.registerHarnessDoc(null)).to.throw(PluginError);
    expect(() =>
      manager.registerHarnessDoc({ uri: '', file: '/x', name: 'x', description: 'x' }),
    ).to.throw(PluginError);
    expect(() =>
      manager.registerHarnessDoc({ uri: 'harness:///x', file: '/x', name: 'x' }),
    ).to.throw(PluginError);
  });

  it('reports a PluginError that is still an Error', () => {
    const manager = new PluginManager();
    try {
      manager.registerSystemPromptSetup(null);
      expect.fail('the registration must throw');
    } catch (error) {
      expect(error).to.be.instanceOf(PluginError);
      expect(error).to.be.instanceOf(Error);
      expect((error as PluginError).message).to.be.a('string');
    }
  });
});
