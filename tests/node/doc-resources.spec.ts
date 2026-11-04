/**
 * Specs for the plugin document section of the overview: the entry point composes with the live list.
 */

import { expect } from 'chai';
import { pluginDocumentSection } from '../../dist/renderer/doc-resources.js';

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
