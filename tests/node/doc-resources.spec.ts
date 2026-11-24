/**
 * Specs for the plugin document section of the overview: the entry point composes with the live
 * list. The known-paths document renders the whole rule list with names and mode meanings.
 */

import { expect } from 'chai';
import { knownPathsDocument, pluginDocumentSection } from '../../dist/shared/harness-docs.js';

describe('the plugin document section of the overview', () => {
  it('builds one list line per registered document', () => {
    const section = pluginDocumentSection([
      {
        uri: 'harness:///nodewavenui/selftest.md',
        file: '/plugins/selftest/selftest.md',
        name: 'selftest',
        description: 'The app self test.',
      },
    ]);
    expect(section).to.equal(
      '# Plugin documents\n\nThese documents come from the enabled plugin folders. They leave with their plugin.\n\n- `harness:///nodewavenui/selftest.md` — The app self test.\n',
    );
  });

  it('reads null when no plugin registered a document', () => {
    expect(pluginDocumentSection([])).to.equal(null);
  });
});

describe('the known-paths document', () => {
  it('lists every rule with its name and its mode meaning', () => {
    const text = knownPathsDocument([
      { path: 'src', name: 'Source code', mode: 'allow' },
      { path: 'secrets', name: '', mode: 'deny' },
    ]);
    expect(text).to.include('- **Source code** — `src` — allow: reads and writes need no request');
    expect(text).to.include('- `secrets` — deny: the agent reaches nothing on this path');
    expect(text).to.include('the longest rule wins');
  });

  it('answers one placeholder line when no path is registered', () => {
    expect(knownPathsDocument([])).to.include('- (no path is registered)');
  });
});
