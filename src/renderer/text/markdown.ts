/**
 * The markdown parser of the app: it reads the markdown the agents answer with and answers a
 * block model, never DOM. The renderer in `render.ts` builds elements from the model, so no
 * markdown text ever injects markup. The grammar covers what agent replies carry: fenced code,
 * headings, lists, block quotes, paragraphs, and inline code, emphasis, strong, and links.
 */

/** One styled run of inline text. The flags stack, but the parser emits at most one per run. */
export interface InlineRun {
  readonly text: string;
  readonly code?: boolean;
  readonly strong?: boolean;
  readonly emphasis?: boolean;
  /** The link target, when the run is a link. The renderer shows it without navigating. */
  readonly href?: string;
}

/** One block of a parsed markdown document. */
export type MarkdownBlock =
  | { readonly kind: 'code'; readonly language: string | null; readonly code: string } |
  { readonly kind: 'heading'; readonly level: number; readonly runs: readonly InlineRun[] } |
  { readonly kind: 'paragraph'; readonly runs: readonly InlineRun[] } |
  { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly InlineRun[])[] } |
  { readonly kind: 'quote'; readonly blocks: readonly MarkdownBlock[] };

/** The inline markers the parser knows, tried in order. A code span hides every other marker. */
const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/**
 * Parses one inline text into styled runs.
 *
 * @param text The inline text of one line or paragraph.
 * @returns The runs, in order. Plain text between markers arrives without flags.
 */
export function parseInline(text: string): readonly InlineRun[] {
  const runs: InlineRun[] = [];
  let cursor = 0;
  INLINE_PATTERN.lastIndex = 0;
  for (let match = INLINE_PATTERN.exec(text); match !== null; match = INLINE_PATTERN.exec(text)) {
    if (match.index > cursor) {
      runs.push({ text: text.slice(cursor, match.index) });
    }
    const [whole, code, strong, emphasis, link] = match;
    if (code) {
      runs.push({ text: code.slice(1, -1), code: true });
    } else if (strong) {
      runs.push({ text: strong.slice(2, -2), strong: true });
    } else if (emphasis) {
      runs.push({ text: emphasis.slice(1, -1), emphasis: true });
    } else if (link) {
      const separator = link.indexOf('](');
      runs.push({ text: link.slice(1, separator), href: link.slice(separator + 2, -1) });
    }
    cursor = match.index + (whole ?? '').length;
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor) });
  }
  return runs.length === 0 && text.length === 0 ? [] : runs;
}

/** True when one line closes an open fence. */
function fenceClose(line: string): boolean {
  return /^```\s*$/.test(line);
}

/** Reads one list item marker. Null when the line is no item. */
function listMarker(line: string): { ordered: boolean; rest: string } | null {
  const bullet = /^[-*]\s+(.*)$/.exec(line);
  if (bullet) {
    return { ordered: false, rest: bullet[1]! };
  }
  const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) {
    return { ordered: true, rest: ordered[1]! };
  }
  return null;
}

/**
 * Parses one markdown document into blocks.
 *
 * @param text The whole document text.
 * @returns The blocks, in order.
 */
export function parseMarkdown(text: string): readonly MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = /^```([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const tag = fence[1] ?? '';
      const language = tag.length > 0 ? tag : null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !fenceClose(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', language, code: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, runs: parseInline(heading[2]!) });
      index += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index]!.startsWith('>')) {
        quoted.push(lines[index]!.replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const ordered = marker.ordered;
      const items: InlineRun[][] = [];
      while (index < lines.length) {
        const candidate = listMarker(lines[index]!);
        if (!candidate || candidate.ordered !== ordered) {
          break;
        }
        items.push([...parseInline(candidate.rest)]);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !/^```/.test(lines[index]!) &&
      !/^#{1,6}\s/.test(lines[index]!) &&
      !lines[index]!.startsWith('>') &&
      !listMarker(lines[index]!)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}
