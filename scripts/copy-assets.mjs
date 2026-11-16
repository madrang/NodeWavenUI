// Copies static renderer assets (HTML/CSS) into dist/. TypeScript handles the rest.
// Runtime dependencies that the sandboxed renderer cannot import as bare module names copy
// here at build time too, out of node_modules.
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const outputDir = fileURLToPath(new URL('../dist/renderer/', import.meta.url));

cpSync(sourceDir, outputDir, {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
});

console.log('renderer assets copied to dist/renderer');

const jasmineSource = fileURLToPath(new URL('../node_modules/jasmine-core/lib/jasmine-core/', import.meta.url));
const jasmineTarget = fileURLToPath(new URL('../plugins/selftest/libs/', import.meta.url));
for (const file of ['jasmine.js', 'jasmine.css']) {
  cpSync(`${jasmineSource}${file}`, `${jasmineTarget}${file}`);
}

console.log('jasmine bundle copied to plugins/selftest/libs');

// The sandboxed renderer cannot import from node_modules, so the jsdiff ESM build copies to
// dist/renderer/libs/diff and the pages import it with relative specifiers.
const diffSource = fileURLToPath(new URL('../node_modules/diff/libesm/', import.meta.url));
const diffTarget = fileURLToPath(new URL('../dist/renderer/libs/diff/', import.meta.url));
cpSync(diffSource, diffTarget, { recursive: true });

console.log('jsdiff copied to dist/renderer/libs/diff');

// Prism colors the code of the chat, the tool results, and the diff views. The grammar files
// register on the Prism global in dependency order, so the pages load them as classic scripts.
const prismSource = fileURLToPath(new URL('../node_modules/prismjs/components/', import.meta.url));
const prismTarget = fileURLToPath(new URL('../dist/renderer/libs/prism/', import.meta.url));
for (const file of [
  'prism-core.js',
  'prism-markup.js',
  'prism-clike.js',
  'prism-javascript.js',
  'prism-typescript.js',
  'prism-css.js',
  'prism-json.js',
  'prism-markdown.js',
  'prism-bash.js',
]) {
  cpSync(`${prismSource}${file}`, `${prismTarget}${file}`);
}

console.log('prism copied to dist/renderer/libs/prism');
