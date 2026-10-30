// Copies static renderer assets (HTML/CSS) into dist/. TypeScript handles the rest.
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const outputDir = fileURLToPath(new URL('../dist/renderer/', import.meta.url));

cpSync(sourceDir, outputDir, {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
});

console.log('renderer assets copied to dist/renderer');
