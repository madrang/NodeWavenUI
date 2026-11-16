// Copies static renderer assets (HTML/CSS) into dist/. TypeScript handles the rest.
// The selftest plugin vendors the Jasmine browser bundle the same way, out of node_modules.
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
const jasmineTarget = fileURLToPath(new URL('../plugins/selftest/vendor/', import.meta.url));
for (const file of ['jasmine.js', 'jasmine.css']) {
  cpSync(`${jasmineSource}${file}`, `${jasmineTarget}${file}`);
}

console.log('jasmine bundle vendored to plugins/selftest/vendor');

// The sandboxed renderer cannot import from node_modules, so the jsdiff ESM build rides the
// app protocol as a vendored folder under dist/renderer/vendor/diff.
const diffSource = fileURLToPath(new URL('../node_modules/diff/libesm/', import.meta.url));
const diffTarget = fileURLToPath(new URL('../dist/renderer/vendor/diff/', import.meta.url));
cpSync(diffSource, diffTarget, { recursive: true });

console.log('jsdiff vendored to dist/renderer/vendor/diff');
