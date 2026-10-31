// Removes build output: the compiled dist/ tree and the incremental buildinfo files.
// A buildinfo file that outlives its outputs makes `tsc -b` treat the missing outputs as current,
// so both must go together.
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(`${root}/dist`, { recursive: true, force: true });
for (const name of readdirSync(root)) {
  if (name.endsWith('.tsbuildinfo')) {
    rmSync(`${root}/${name}`);
  }
}
console.log('dist/ and the buildinfo files removed');
