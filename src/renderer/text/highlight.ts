/**
 * The code tokenizer wrapper over Prism. The pages load Prism and its grammars as classic
 * scripts, so every grammar registers on the global before this module runs. The wrapper answers
 * token runs for any caller that draws its own nodes: the markdown renderer, the diff views, and
 * the editor. Without Prism, every text answers as one plain run.
 */

/** One token run of highlighted code: the text and its Prism type, or null for plain text. */
export interface HighlightRun {
  readonly text: string;
  readonly type: string | null;
}

/** One Prism token of the loaded grammar runtime. */
interface PrismToken {
  readonly type: string;
  readonly content: string | readonly PrismTokenPart[];
}

/** One part of a token stream: plain text or one nested token. */
type PrismTokenPart = string | PrismToken;

/** The Prism surface the wrapper needs. */
interface PrismLike {
  readonly languages: Readonly<Record<string, unknown>>;
  tokenize(text: string, grammar: unknown): readonly PrismTokenPart[];
}

/** Reads the loaded Prism, or null when the page carries no Prism. */
function prism(): PrismLike | null {
  const candidate = (globalThis as { Prism?: unknown }).Prism;
  return typeof candidate === 'object' && candidate ? (candidate as PrismLike) : null;
}

/** The language tags and file extensions the registry knows, mapped to their Prism grammar. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
};

/** Reads the Prism grammar name of one language tag or file extension, or null. */
export function languageName(tag: string): string | null {
  const lowered = tag.toLowerCase();
  const name = LANGUAGE_ALIASES[lowered] ?? lowered;
  return prism()?.languages[name] ? name : null;
}

/** Reads the Prism grammar name of one file path, from its extension, or null. */
export function languageOfPath(path: string): string | null {
  const base = path.split('/').at(-1) ?? path;
  if (!base.includes('.')) {
    return null;
  }
  return languageName(base.slice(base.lastIndexOf('.') + 1));
}

/** Flattens one Prism token stream into runs. */
function flatten(parts: readonly PrismTokenPart[], type: string | null, runs: HighlightRun[]): void {
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.length > 0) {
        runs.push({ text: part, type });
      }
      continue;
    }
    const nested = part.content;
    if (typeof nested === 'string') {
      if (nested.length > 0) {
        runs.push({ text: nested, type: part.type });
      }
      continue;
    }
    flatten(nested, part.type, runs);
  }
}

/**
 * Tokenizes one code text into highlight runs.
 *
 * @param code The code text.
 * @param language The Prism grammar name, or null for plain text.
 * @returns The runs, in order. Without a grammar the whole text arrives as one plain run.
 */
export function highlightRuns(code: string, language: string | null): readonly HighlightRun[] {
  const runtime = prism();
  const grammar = language ? runtime?.languages[language] : undefined;
  if (!runtime || !grammar) {
    return [{ text: code, type: null }];
  }
  const runs: HighlightRun[] = [];
  flatten(runtime.tokenize(code, grammar), null, runs);
  return runs;
}
