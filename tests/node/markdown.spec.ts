/**
 * Specs for the markdown parser and the highlight wrapper fallback: the parser answers the block
 * model the renderer builds on, and the wrapper answers one plain run when no Prism loaded.
 */

import { expect } from 'chai';
import { parseInline, parseMarkdown } from '../../dist/renderer/text/markdown.js';
import { highlightRuns, languageName, languageOfPath } from '../../dist/renderer/text/highlight.js';

describe('the markdown parser', () => {
  it('parses a fenced code block with its language', () => {
    const blocks = parseMarkdown('before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter');
    expect(blocks).to.have.lengthOf(3);
    expect(blocks[1]).to.deep.equal({ kind: 'code', language: 'ts', code: 'const a = 1;\nconst b = 2;' });
  });

  it('reads a plain fence without a language', () => {
    const blocks = parseMarkdown('```\nplain\n```');
    expect(blocks[0]).to.deep.equal({ kind: 'code', language: null, code: 'plain' });
  });

  it('keeps an unclosed fence to the end', () => {
    const blocks = parseMarkdown('```js\none\n');
    expect(blocks).to.have.lengthOf(1);
    expect(blocks[0]).to.deep.equal({ kind: 'code', language: 'js', code: 'one\n' });
  });

  it('parses headings by level', () => {
    const blocks = parseMarkdown('## Fix the build');
    expect(blocks[0]).to.deep.equal({ kind: 'heading', level: 2, runs: [{ text: 'Fix the build' }] });
  });

  it('groups list items and keeps the ordered flag', () => {
    const bullet = parseMarkdown('- one\n- two');
    expect(bullet[0]).to.deep.equal({
      kind: 'list',
      ordered: false,
      items: [[{ text: 'one' }], [{ text: 'two' }]],
    });
    const ordered = parseMarkdown('1. first\n2. second');
    expect(ordered[0]).to.deep.equal({
      kind: 'list',
      ordered: true,
      items: [[{ text: 'first' }], [{ text: 'second' }]],
    });
  });

  it('parses a quote as nested blocks', () => {
    const blocks = parseMarkdown('> quoted');
    expect(blocks[0]).to.deep.equal({ kind: 'quote', blocks: [{ kind: 'paragraph', runs: [{ text: 'quoted' }] }] });
  });

  it('joins paragraph lines and stops at the next marker', () => {
    const blocks = parseMarkdown('line one\nline two\n- item');
    expect(blocks).to.have.lengthOf(2);
    expect(blocks[0]).to.deep.equal({ kind: 'paragraph', runs: [{ text: 'line one\nline two' }] });
    expect(blocks[1]?.kind).to.equal('list');
  });

  it('parses inline code, strong, emphasis, and links in order', () => {
    const runs = parseInline('plain `code` **bold** *soft* [site](https://example.com) tail');
    expect(runs).to.deep.equal([
      { text: 'plain ' },
      { text: 'code', code: true },
      { text: ' ' },
      { text: 'bold', strong: true },
      { text: ' ' },
      { text: 'soft', emphasis: true },
      { text: ' ' },
      { text: 'site', href: 'https://example.com' },
      { text: ' tail' },
    ]);
  });

  it('leaves a code span opaque to other markers', () => {
    const runs = parseInline('`a **b** c`');
    expect(runs).to.deep.equal([{ text: 'a **b** c', code: true }]);
  });

  it('answers empty for an empty text', () => {
    expect(parseInline('')).to.deep.equal([]);
    expect(parseMarkdown('')).to.deep.equal([]);
  });
});

describe('the highlight wrapper fallback', () => {
  it('answers one plain run for any language without Prism', () => {
    expect(highlightRuns('const a = 1;', 'javascript')).to.deep.equal([{ text: 'const a = 1;', type: null }]);
  });

  it('answers no language without Prism', () => {
    expect(languageName('ts')).to.equal(null);
    expect(languageOfPath('/work/file.ts')).to.equal(null);
    expect(languageOfPath('/work/noext')).to.equal(null);
  });
});
