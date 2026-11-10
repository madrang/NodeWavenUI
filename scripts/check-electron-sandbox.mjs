/**
 * The Linux sandbox guard of `npm start`. Chromium needs either the unprivileged user
 * namespace or the setuid helper under node_modules/electron/dist/chrome-sandbox. When the
 * kernel denies the namespace and the helper is not configured, Chromium aborts with a FATAL
 * line before any app code runs, so this script checks both first and prints the fix commands.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandboxHelper = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  'electron',
  'dist',
  'chrome-sandbox',
);

if (process.platform !== 'linux') {
  process.exit(0);
}

/** True when the setuid helper is configured: root-owned with the setuid bit. */
function helperConfigured() {
  try {
    const stat = statSync(sandboxHelper);
    return stat.uid === 0 && (stat.mode & 0o4000) !== 0;
  } catch {
    // No helper file: an Electron layout without it needs no check.
    return true;
  }
}

if (helperConfigured()) {
  process.exit(0);
}

// The helper is missing its configuration, so the kernel must allow the unprivileged user
// namespace instead. `unshare -Ur` answers exactly that question.
const probe = spawnSync('unshare', ['-Ur', 'true'], { stdio: 'ignore' });
if (probe.status === 0) {
  process.exit(0);
}

const helper = sandboxHelper;
console.error(
  [
    '',
    'Electron cannot start: the sandbox needs one of two things this machine gives neither.',
    'The kernel denies the unprivileged user namespace (Ubuntu: apparmor_restrict_unprivileged_userns),',
    'and the setuid helper is not configured. Run:',
    '',
    `  sudo chown root:root ${helper}`,
    `  sudo chmod 4755 ${helper}`,
    '',
    'Every npm install that reinstalls Electron resets the ownership, so rerun both lines then.',
    '',
  ].join('\n'),
);
process.exit(1);
