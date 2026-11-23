/**
 * Specs for the diff model: a unified diff reads into its file head, hunk heads, and lines, each
 * with its marker and its text without the marker, and a section that names no file falls back to
 * the given path.
 */

import { expect } from 'chai';
import { readDiff } from '../../dist/renderer/text/diff.js';

const PATCH = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const kept = 1;',
  '-const old = 2;',
  '+const fresh = 2;',
  '+const added = 3;',
  '\\ No newline at end of file',
].join('\n');

describe('the diff model', () => {
  it('reads one unified diff into its lines, with the markers off the text', () => {
    expect(readDiff(PATCH, '/work/src/app.ts')).to.deep.equal([
      { kind: 'file', marker: '', text: 'b/src/app.ts' },
      { kind: 'hunk', marker: '@@', text: ' -1,2 +1,3 @@' },
      { kind: 'context', marker: ' ', text: 'const kept = 1;' },
      { kind: 'remove', marker: '-', text: 'const old = 2;' },
      { kind: 'add', marker: '+', text: 'const fresh = 2;' },
      { kind: 'add', marker: '+', text: 'const added = 3;' },
      // The note keeps the space after its marker, the way the review view renders it.
      { kind: 'note', marker: '\\', text: ' No newline at end of file' },
    ]);
  });

  it('heads a section that names no file with the given path', () => {
    const lines = readDiff('@@ -1,1 +1,1 @@\n-old\n+new', '/work/note.txt');
    expect(lines).to.deep.equal([
      { kind: 'file', marker: '', text: '/work/note.txt' },
      { kind: 'hunk', marker: '@@', text: ' -1,1 +1,1 @@' },
      { kind: 'remove', marker: '-', text: 'old' },
      { kind: 'add', marker: '+', text: 'new' },
    ]);
  });
});
