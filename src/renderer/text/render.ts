/**
 * The DOM renderer of the text stack: it builds elements from the markdown block model and the
 * highlight runs, and it never writes markup from raw text. Every element is constructed, so
 * nothing injects. A link renders as styled text with its target in the tooltip, because the
 * workspace page never navigates away.
 */

import { highlightRuns, languageName } from './highlight.js';
import type { InlineRun, MarkdownBlock } from './markdown.js';
import { parseMarkdown } from './markdown.js';

/** Builds one element with a class, shorthand for the node construction below. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** Appends one token run list to a code element, one span per run with its Prism token class. */
export function appendCodeRuns(target: HTMLElement, code: string, language: string | null): void {
  for (const run of highlightRuns(code, language)) {
    if (run.type) {
      const span = element('span', `token ${run.type}`);
      span.textContent = run.text;
      target.append(span);
      continue;
    }
    target.append(run.text);
  }
}

/** Appends one inline run list to an element. */
function appendInline(target: HTMLElement, runs: readonly InlineRun[]): void {
  for (const run of runs) {
    if (run.code) {
      const chip = element('code', 'md-inline-code');
      chip.textContent = run.text;
      target.append(chip);
      continue;
    }
    let holder: HTMLElement = target;
    if (run.href) {
      const link = element('span', 'md-link');
      link.title = run.href;
      target.append(link);
      holder = link;
    }
    if (run.strong) {
      const strong = element('strong', 'md-strong');
      strong.textContent = run.text;
      holder.append(strong);
      continue;
    }
    if (run.emphasis) {
      const emphasis = element('em', 'md-emphasis');
      emphasis.textContent = run.text;
      holder.append(emphasis);
      continue;
    }
    holder.append(run.text);
  }
}

/** Builds one fenced code block: the language label and the highlighted code body. */
function buildCodeBlock(block: Extract<MarkdownBlock, { kind: 'code' }>): HTMLElement {
  const wrap = element('div', 'md-code');
  const grammar = block.language ? languageName(block.language) : null;
  if (block.language) {
    const label = element('span', 'md-code-label');
    label.textContent = grammar ?? block.language;
    wrap.append(label);
  }
  const body = element('code', 'md-code-body');
  appendCodeRuns(body, block.code, grammar);
  wrap.append(body);
  return wrap;
}

/** Builds one markdown block as an element. */
function buildBlock(block: MarkdownBlock): HTMLElement {
  if (block.kind === 'code') {
    return buildCodeBlock(block);
  }
  if (block.kind === 'heading') {
    const heading = element(`h${Math.min(block.level + 1, 6)}` as 'h2', `md-heading md-level-${block.level}`);
    appendInline(heading, block.runs);
    return heading;
  }
  if (block.kind === 'list') {
    const list = element(block.ordered ? 'ol' : 'ul', 'md-list');
    for (const item of block.items) {
      const li = element('li', 'md-list-item');
      appendInline(li, item);
      list.append(li);
    }
    return list;
  }
  if (block.kind === 'quote') {
    const quote = element('blockquote', 'md-quote');
    for (const nested of block.blocks) {
      quote.append(buildBlock(nested));
    }
    return quote;
  }
  const paragraph = element('p', 'md-paragraph');
  appendInline(paragraph, block.runs);
  return paragraph;
}

/**
 * Renders one markdown text into a container. The container keeps its children: the renderer
 * clears it first, so one element serves repeated renders.
 *
 * @param container The element that holds the rendered blocks.
 * @param text The markdown text.
 */
export function renderMarkdown(container: HTMLElement, text: string): void {
  container.replaceChildren();
  for (const block of parseMarkdown(text)) {
    container.append(buildBlock(block));
  }
}
