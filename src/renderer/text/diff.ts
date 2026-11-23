/**
 * The diff model of the text stack: it reads one unified diff into the lines a view renders,
 * through the jsdiff parser. The DOM renderer of the stack builds on the model (`render.ts`), and
 * the specs cover the model alone.
 */

import { parsePatch } from '../libs/diff/index.js';

/** The kind of one line of a rendered diff. */
export type DiffLineKind = 'file' | 'hunk' | 'add' | 'remove' | 'context' | 'note';

/** One line of a rendered diff: its kind, its marker, and its text without the marker. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly marker: string;
  readonly text: string;
}

/**
 * Reads one unified diff into its lines.
 *
 * @param patch The unified diff text.
 * @param path The path of the file the patch changes. It heads a section that names no file.
 * @returns The lines in file order: one file head, then each hunk head and its lines.
 */
export function readDiff(patch: string, path: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const file of parsePatch(patch)) {
    lines.push({ kind: 'file', marker: '', text: file.newFileName ?? file.oldFileName ?? path });
    for (const hunk of file.hunks) {
      lines.push({
        kind: 'hunk',
        marker: '@@',
        text: ` -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      });
      for (const line of hunk.lines) {
        const marker = line.charAt(0);
        const text = line.slice(1);
        if (marker === '+') {
          lines.push({ kind: 'add', marker, text });
        } else if (marker === '-') {
          lines.push({ kind: 'remove', marker, text });
        } else if (marker === '\\') {
          lines.push({ kind: 'note', marker, text });
        } else {
          lines.push({ kind: 'context', marker: ' ', text });
        }
      }
    }
  }
  return lines;
}
