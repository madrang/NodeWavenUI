/**
 * The typing shim of the jsdiff dependency copy. The build copies `node_modules/diff/libesm`
 * to `dist/renderer/libs/diff`, and the sandboxed renderer imports it with a relative
 * specifier, because it cannot resolve bare module names. The signatures cover the functions
 * the app uses.
 */

/** One parsed file section of a unified diff. */
export interface ParsedPatchFile {
  oldFileName?: string;
  newFileName?: string;
  hunks: ParsedHunk[];
}

/** One hunk of a parsed patch. */
export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** The patch application options the app uses. */
export interface ApplyOptions {
  fuzzFactor?: number;
}

/** Creates one unified diff patch over two texts. */
export declare function createPatch(
  fileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
  options?: { context?: number },
): string;

/** Parses one unified diff text into its file sections and hunks. */
export declare function parsePatch(uniDiff: string, options?: Record<string, unknown>): ParsedPatchFile[];

/** Applies one unified diff patch to a text. False when the patch does not fit. */
export declare function applyPatch(
  source: string,
  patch: string | ParsedPatchFile[],
  options?: ApplyOptions,
): string | false;
