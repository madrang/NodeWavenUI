/**
 * The Editor window: a plain-text editor built on the EditContext API, driven through the
 * `nodewavenEditor` page global. One document lives in one window (see docs/editor.md).
 * The EditContext instance holds the text and the selection. The page renders the text as one
 * span per line, colored by the Prism runs of the file language, so the native caret, the mouse
 * selection, and the agent calls share one state over highlighted code. The buffer and the view
 * stay separate: the offset mapping between the plain text and the line spans lives in this page.
 */

import './edit-context.js';
import { requireElement } from './dom.js';
import { resolveThemeId, THEME_MIRROR_KEY } from './theme.js';
import { highlightRuns, languageName, type HighlightRun } from './text/highlight.js';

/** The title bar, the scroll area with gutter and editing host, the status bar, and the unsupported banner. */
const titleBar = requireElement<HTMLElement>('#editor-title');
const scrollArea = requireElement<HTMLElement>('#editor-scroll');
const gutter = requireElement<HTMLElement>('#editor-gutter');
const host = requireElement<HTMLElement>('#editor-root');
const statusBar = requireElement<HTMLElement>('#editor-status');
const unsupported = requireElement<HTMLElement>('#editor-unsupported');

/** The edit context, or null when the Chromium build predates the API. */
const editContext: EditContext | null = typeof EditContext !== 'undefined' ? new EditContext({ text: '' }) : null;

/**
 * The edit context.
 *
 * @returns The context.
 * @throws Error when the Chromium build carries no EditContext API.
 */
function ctx(): EditContext {
  if (!editContext) {
    throw new Error('The EditContext API is not available in this Chromium build. The editor needs Chromium 133 or later.');
  }
  return editContext;
}

/** The code unit of the line break. */
const NEWLINE = 10;

/** The Prism grammar name of the document, or null for plain text. The title extension decides. */
let activeLanguage: string | null = null;

/** The start offset of every rendered line element, rebuilt on each render. */
const lineStarts = new Map<HTMLElement, number>();

/** One piece of one rendered line: a text slice and its Prism token type, or null for plain. */
interface LinePiece {
  readonly text: string;
  readonly type: string | null;
}

/** Splits the highlight runs of the whole text into the pieces of each line. */
function linePieces(runs: readonly HighlightRun[]): LinePiece[][] {
  const lines: LinePiece[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1]?.push({ text: part, type: run.type });
      }
    });
  }
  return lines;
}

/** Reads the text length of one rendered line element. */
function lineTextLength(line: HTMLElement): number {
  let length = 0;
  for (const node of line.childNodes) {
    length += node.textContent?.length ?? 0;
  }
  return length;
}

/** Reads the text nodes of one rendered line element, in order. */
function textNodesOf(line: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walk = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child instanceof Text) {
        nodes.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(line);
  return nodes;
}

/** Reads the line element one node sits in, or null outside the lines. */
function lineOf(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== host) {
    if (current instanceof HTMLElement && lineStarts.has(current)) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/** Reads the DOM position of one text offset: the text node and the offset inside it. The offset
 * of a line break maps onto the end of its line, and an empty line maps onto the line itself. */
function positionAt(offset: number): { readonly node: Node; readonly offset: number } | null {
  let chosen: HTMLElement | null = null;
  for (const line of lineStarts.keys()) {
    const start = lineStarts.get(line) ?? 0;
    if (start <= offset && (!chosen || start > (lineStarts.get(chosen) ?? 0))) {
      chosen = line;
    }
  }
  if (!chosen) {
    return null;
  }
  const base = lineStarts.get(chosen) ?? 0;
  let local = Math.min(offset - base, lineTextLength(chosen));
  if (local < 0) {
    local = 0;
  }
  let consumed = 0;
  for (const textNode of textNodesOf(chosen)) {
    const length = textNode.data.length;
    if (local <= consumed + length) {
      return { node: textNode, offset: local - consumed };
    }
    consumed += length;
  }
  return { node: chosen, offset: chosen.childNodes.length };
}

/** One stored editor state, for undo and redo. */
interface EditorSnapshot {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/** How many steps the undo stack keeps. */
const UNDO_LIMIT = 100;

const undoStack: EditorSnapshot[] = [];
const redoStack: EditorSnapshot[] = [];

/** The last state the page rendered. Every change stores this state as one undo step. */
let committed: EditorSnapshot = { text: '', selectionStart: 0, selectionEnd: 0 };

/** True while an input method composes text. Composition intermediates do not become undo steps. */
let composing = false;

/** The range the input method asked to render as an active composition. */
let compositionRange: { readonly start: number; readonly end: number } | null = null;

/** Stores the last rendered state as one undo step and empties the redo stack. */
function recordUndoStep(): void {
  if (composing) {
    return;
  }
  undoStack.push(committed);
  if (undoStack.length > UNDO_LIMIT) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

/** Applies a whole stored state: the text, the selection, and a new render. */
function applyState(snapshot: EditorSnapshot): void {
  const context = ctx();
  context.updateText(0, context.text.length, snapshot.text);
  context.updateSelection(snapshot.selectionStart, snapshot.selectionEnd);
  render();
}

/** Steps one state back. Answers with a confirmation for the caller. */
function undo(): string {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    return 'nothing to undo';
  }
  redoStack.push(committed);
  applyState(snapshot);
  return `undone, ${undoStack.length} steps left`;
}

/** Steps one stored state forward again. Answers with a confirmation for the caller. */
function redo(): string {
  const snapshot = redoStack.pop();
  if (!snapshot) {
    return 'nothing to redo';
  }
  undoStack.push(committed);
  applyState(snapshot);
  return `redone, ${redoStack.length} steps left`;
}

/** Replaces a text range through the undoable path and moves the caret behind the new text. */
function applyEdit(start: number, end: number, replacement: string): void {
  const context = ctx();
  recordUndoStep();
  context.updateText(start, end, replacement);
  context.updateSelection(start + replacement.length, start + replacement.length);
  render();
}

/** Replaces the current selection with the given text, through the undoable path. */
function applySelectionEdit(replacement: string): void {
  const context = ctx();
  const start = Math.min(context.selectionStart, context.selectionEnd);
  const end = Math.max(context.selectionStart, context.selectionEnd);
  applyEdit(start, end, replacement);
}

/** The selected text of the document, or an empty string. */
function selectedText(): string {
  const context = ctx();
  const start = Math.min(context.selectionStart, context.selectionEnd);
  const end = Math.max(context.selectionStart, context.selectionEnd);
  return context.text.slice(start, end);
}

/** The client rectangle of the caret or selection, or null when the layout hides it. */
function caretRect(): DOMRect | null {
  const context = ctx();
  const range = document.createRange();
  const start = Math.min(context.selectionStart, context.selectionEnd);
  const end = Math.max(context.selectionStart, context.selectionEnd);
  const from = positionAt(start);
  const to = positionAt(end);
  if (from && to) {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const rect = range.getClientRects()[0];
    if (rect) {
      return new DOMRect(rect.x, rect.y, Math.max(rect.width, 1), rect.height);
    }
  }
  // A caret at a line boundary can carry no rectangle. The character before it gives the position.
  if (start > 0) {
    const before = positionAt(start - 1);
    const after = positionAt(start);
    if (before && after) {
      range.setStart(before.node, before.offset);
      range.setEnd(after.node, after.offset);
      const previous = range.getClientRects()[0];
      if (previous) {
        return new DOMRect(previous.right, previous.y, Math.max(previous.width, 1), previous.height);
      }
    }
  }
  const hostRect = host.getBoundingClientRect();
  return new DOMRect(hostRect.x, hostRect.y, 1, hostRect.height > 0 ? hostRect.height : 16);
}

/** Tells the input method where the editable area and the selection sit. */
function notifyBounds(): void {
  const context = ctx();
  context.updateControlBounds(scrollArea.getBoundingClientRect());
  const caret = caretRect();
  if (caret) {
    context.updateSelectionBounds(caret);
  }
}

/** Scrolls the caret into view when it sits outside the visible area. */
function scrollCaretIntoView(): void {
  const caret = caretRect();
  if (!caret) {
    return;
  }
  const viewport = scrollArea.getBoundingClientRect();
  if (caret.bottom > viewport.bottom) {
    scrollArea.scrollTop += caret.bottom - viewport.bottom;
  } else if (caret.top < viewport.top) {
    scrollArea.scrollTop -= viewport.top - caret.top;
  }
}

/** Maps one DOM selection position onto a text offset. Positions outside the lines map to null. */
function domPositionToOffset(node: Node | null, offset: number): number | null {
  if (!node) {
    return null;
  }
  if (node === host) {
    // The browser placed the selection on the host itself, before or after the lines.
    return offset === 0 ? 0 : ctx().text.length;
  }
  const line = lineOf(node);
  if (!line) {
    return null;
  }
  const base = lineStarts.get(line) ?? 0;
  if (node === line) {
    return base + (offset === 0 ? 0 : lineTextLength(line));
  }
  if (!(node instanceof Text)) {
    return base;
  }
  let local = offset;
  for (const textNode of textNodesOf(line)) {
    if (textNode === node) {
      return base + Math.min(local, textNode.data.length);
    }
    local += textNode.data.length;
  }
  return base;
}

/** Reads the DOM selection as offsets into the text, or null when it sits outside the editor. */
function readDomSelection(): { readonly start: number; readonly end: number } | null {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return null;
  }
  const anchor = domPositionToOffset(selection.anchorNode, selection.anchorOffset);
  const focus = domPositionToOffset(selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) {
    return null;
  }
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

/** Restores the DOM selection from the edit context selection. */
function renderSelection(): void {
  const context = ctx();
  const selection = document.getSelection();
  const start = positionAt(context.selectionStart);
  const end = positionAt(context.selectionEnd);
  if (!selection || !start || !end) {
    return;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The client rectangle of the character at an offset. A one-character look back covers line boundaries. */
function charRectAt(offset: number): DOMRect | null {
  const from = positionAt(offset);
  const to = positionAt(offset + 1) ?? from;
  if (!from || !to) {
    return null;
  }
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  let rect = range.getClientRects()[0];
  if (rect === undefined && offset > 0) {
    const before = positionAt(offset - 1);
    if (before) {
      range.setStart(before.node, before.offset);
      range.setEnd(from.node, from.offset);
      rect = range.getClientRects()[0];
    }
  }
  return rect ?? null;
}

/** Rebuilds the line numbers. Each number sits at the top of its logical line, so wrapped lines share their number. */
function renderGutter(text: string): void {
  const lineStarts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === NEWLINE) {
      lineStarts.push(index + 1);
    }
  }
  // The gutter width follows the widest number, and the width change must land before the tops are measured.
  gutter.style.minWidth = `${String(lineStarts.length).length + 2}ch`;
  const gutterTop = gutter.getBoundingClientRect().top;
  const fallbackTop = host.getBoundingClientRect().top - gutterTop;
  const numbers: HTMLElement[] = [];
  lineStarts.forEach((start, index) => {
    const element = document.createElement('span');
    element.textContent = String(index + 1);
    const rect = charRectAt(start);
    if (rect) {
      // The start of a line measures its own character. A trailing empty line sits below the last line break.
      element.style.top = start < text.length ? `${rect.top - gutterTop}px` : `${rect.bottom - gutterTop}px`;
    } else {
      element.style.top = `${fallbackTop}px`;
    }
    numbers.push(element);
  });
  gutter.replaceChildren(...numbers);
}

/** Updates the status bar: the caret position, the text length, and the line count. */
function renderStatus(text: string): void {
  const context = ctx();
  const caret = Math.min(context.selectionStart, context.selectionEnd);
  let line = 1;
  let column = 1;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === NEWLINE) {
      lines += 1;
      if (index < caret) {
        line += 1;
        column = 1;
      }
    } else if (index < caret) {
      column += 1;
    }
  }
  statusBar.textContent = `Line ${line}, Col ${column} | ${text.length} characters | ${lines} lines`;
}

/** Styles the active composition range with the highlight registry, or clears the styling. */
function renderComposition(): void {
  const registry = (CSS as { highlights?: Map<string, Highlight> }).highlights;
  if (!registry) {
    return;
  }
  if (!compositionRange) {
    registry.delete('ime-composition');
    return;
  }
  const start = positionAt(compositionRange.start);
  const end = positionAt(compositionRange.end);
  if (!start || !end) {
    registry.delete('ime-composition');
    return;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  registry.set('ime-composition', new Highlight(range));
}

/** Renders the text: one line span per logical line, its pieces colored by the Prism runs of the
 * active language. A full pass per render keeps the offset mapping simple; the line count of an
 * edited file stays small enough that the rebuild costs less than a diff layer. */
function renderText(text: string): void {
  const pieces = linePieces(highlightRuns(text, activeLanguage));
  lineStarts.clear();
  const elements: HTMLElement[] = [];
  let start = 0;
  for (const linePiecesOfLine of pieces) {
    const line = document.createElement('span');
    line.className = 'editor-line';
    for (const piece of linePiecesOfLine) {
      if (piece.type) {
        const token = document.createElement('span');
        token.className = `token ${piece.type}`;
        token.textContent = piece.text;
        line.append(token);
      } else {
        line.append(document.createTextNode(piece.text));
      }
    }
    lineStarts.set(line, start);
    elements.push(line);
    start += linePiecesOfLine.reduce((sum, piece) => sum + piece.text.length, 0) + 1;
  }
  host.replaceChildren(...elements);
}

/** Renders the editor state: the text, the selection, the gutter, the status bar, and the input method bounds. */
function render(): void {
  const context = ctx();
  const text = context.text;
  renderText(text);
  renderSelection();
  renderGutter(text);
  renderStatus(text);
  renderComposition();
  notifyBounds();
  scrollCaretIntoView();
  committed = { text, selectionStart: context.selectionStart, selectionEnd: context.selectionEnd };
}

/** Applies a title: the title bar text, its visibility, the window title, and the language the
 * title extension names. A title without an extension keeps the active language. */
function applyTitle(title: string): void {
  titleBar.textContent = title;
  titleBar.hidden = title.length === 0;
  document.title = title.length > 0 ? `${title} — NodeWavenUI Editor` : 'Editor — NodeWavenUI';
  if (title.includes('.')) {
    activeLanguage = languageName(title.slice(title.lastIndexOf('.') + 1));
  }
}

/** Reads the optional title from the setText options object. */
function readTitleOption(options: unknown): string | undefined {
  if (options === undefined || options === null) {
    return undefined;
  }
  if (typeof options !== 'object') {
    throw new Error('The editor options must be an object: { title, language }.');
  }
  const title = (options as Record<string, unknown>)['title'];
  if (!title) {
    return undefined;
  }
  if (typeof title !== 'string') {
    throw new Error('The editor title must be a string.');
  }
  return title;
}

/** Reads the optional language from the setText options object: a grammar name or a file extension. */
function readLanguageOption(options: unknown): string | undefined {
  if (typeof options !== 'object' || options === null) {
    return undefined;
  }
  const language = (options as Record<string, unknown>)['language'];
  if (!language) {
    return undefined;
  }
  if (typeof language !== 'string') {
    throw new Error('The editor language must be a string.');
  }
  return language;
}

/** Checks that a value is an integer, then clamps it into the text. */
function readOffset(value: unknown, name: string, textLength: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`The ${name} offset must be an integer.`);
  }
  return Math.min(Math.max(value, 0), textLength);
}

/** Empties both stacks. A replaced document carries no steps back. */
function resetUndo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

/** True when the editor page runs embedded in another page, so the view above serves its save
 * and task actions. The editor window stands alone and hears nothing. */
const framed = window.parent !== window;

/** Attaches every editor event. The page calls it once, after the context attached to the host. */
function wireEditor(): void {
  const context = ctx();

  // The context applied the change already. The page renders the new state and stores the old one as one undo step.
  context.addEventListener('textupdate', () => {
    recordUndoStep();
    render();
    // The framing view tracks the dirty state of its buffer from these notes.
    if (framed) {
      window.parent.postMessage({ type: 'nodewavenui-editor-changed' }, '*');
    }
  });

  // The input method asks where the composed characters sit, so it can place its candidate window.
  context.addEventListener('characterboundsupdate', (event) => {
    const bounds: DOMRect[] = [];
    for (let offset = event.rangeStart; offset < event.rangeEnd && offset < ctx().text.length; offset += 1) {
      const rect = charRectAt(offset);
      bounds.push(rect ?? new DOMRect(0, 0, 0, 0));
    }
    context.updateCharacterBounds(event.rangeStart, bounds);
  });

  context.addEventListener('textformatupdate', (event) => {
    const format = event.getTextFormats()[0];
    if (format) {
      compositionRange = { start: format.rangeStart, end: format.rangeEnd };
      renderComposition();
    }
  });

  context.addEventListener('compositionstart', () => {
    composing = true;
  });

  context.addEventListener('compositionend', () => {
    composing = false;
    compositionRange = null;
    renderComposition();
  });

  // The context carries no Enter or Tab. Both go through the undoable edit path.
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      applySelectionEdit('\t');
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      applySelectionEdit('\n');
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      // The framing view owns the file path, so it owns the save. The window keeps its buffer-only role.
      if (framed) {
        window.parent.postMessage({ type: 'nodewavenui-editor-save' }, '*');
      }
      return;
    }
    if (modifier && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      undo();
      return;
    }
    if (modifier && ((event.shiftKey && (event.key === 'z' || event.key === 'Z')) || event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      redo();
      return;
    }
  });

  // The context carries no clipboard. The page moves the clipboard text through the edit path.
  host.addEventListener('copy', (event) => {
    const selection = selectedText();
    if (selection.length === 0) {
      return;
    }
    event.preventDefault();
    event.clipboardData?.setData('text/plain', selection);
  });

  host.addEventListener('cut', (event) => {
    const selection = selectedText();
    if (selection.length === 0) {
      return;
    }
    event.preventDefault();
    event.clipboardData?.setData('text/plain', selection);
    applySelectionEdit('');
  });

  host.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    // eslint-disable-next-line local/prefer-truthiness -- an empty clipboard must still prevent the native paste
    if (text === undefined) {
      return;
    }
    event.preventDefault();
    applySelectionEdit(text);
  });

  // Native caret moves change the DOM selection. The page adopts them into the context.
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== host) {
      return;
    }
    const offsets = readDomSelection();
    if (!offsets) {
      return;
    }
    if (offsets.start !== context.selectionStart || offsets.end !== context.selectionEnd) {
      context.updateSelection(offsets.start, offsets.end);
      renderStatus(context.text);
      notifyBounds();
      committed = { text: context.text, selectionStart: offsets.start, selectionEnd: offsets.end };
    }
  });

  scrollArea.addEventListener('scroll', notifyBounds);
  window.addEventListener('resize', notifyBounds);
}

/** The page global the agents drive. Every method validates its arguments and answers with a confirmation string. */
export const nodewavenEditor = {
  /** Replaces the whole document. The options carry an optional title and language. The undo
   * history starts over. The language names a Prism grammar or a file extension and overrides
   * the one the title extension implies. */
  setText: (text: unknown, options?: unknown): string => {
    if (typeof text !== 'string') {
      throw new Error('The editor text must be a string.');
    }
    const title = readTitleOption(options);
    if (title) {
      applyTitle(title);
    }
    const language = readLanguageOption(options);
    if (language) {
      activeLanguage = languageName(language);
    }
    const context = ctx();
    context.updateText(0, context.text.length, text);
    context.updateSelection(text.length, text.length);
    resetUndo();
    render();
    return `text set: ${text.length} characters`;
  },
  /** Answers with the whole document text. */
  getText: (): string => ctx().text,
  /** Replaces a text range through the undoable path, and moves the caret behind the new text. */
  replace: (start: unknown, end: unknown, text: unknown): string => {
    if (typeof text !== 'string') {
      throw new Error('The replacement text must be a string.');
    }
    const context = ctx();
    const from = readOffset(start, 'start', context.text.length);
    const to = readOffset(end, 'end', context.text.length);
    if (from > to) {
      throw new Error('The start offset must not pass the end offset.');
    }
    applyEdit(from, to, text);
    return `replaced [${from}, ${to}) with ${text.length} characters`;
  },
  /** Sets the selection, focuses the editor, and scrolls the selection into view. */
  select: (start: unknown, end: unknown): string => {
    const context = ctx();
    const from = readOffset(start, 'start', context.text.length);
    const to = readOffset(end, 'end', context.text.length);
    if (from > to) {
      throw new Error('The start offset must not pass the end offset.');
    }
    host.focus();
    context.updateSelection(from, to);
    render();
    return `selection set: [${from}, ${to})`;
  },
  /** Answers with the current selection offsets. */
  getSelection: (): { readonly start: number; readonly end: number } => ({
    start: ctx().selectionStart,
    end: ctx().selectionEnd,
  }),
  /** Sets the title bar text and the window title. An empty title hides the bar. */
  setTitle: (title: unknown): string => {
    if (typeof title !== 'string') {
      throw new Error('The editor title must be a string.');
    }
    applyTitle(title);
    return title.length > 0 ? `title set: ${title}` : 'title cleared';
  },
  /** Empties the document and keeps the title. The undo history starts over. */
  clear: (): string => {
    const context = ctx();
    context.updateText(0, context.text.length, '');
    context.updateSelection(0, 0);
    resetUndo();
    render();
    return 'cleared';
  },
} as const;

(globalThis as { nodewavenEditor?: typeof nodewavenEditor }).nodewavenEditor = nodewavenEditor;

if (!editContext) {
  unsupported.hidden = false;
  scrollArea.hidden = true;
  statusBar.hidden = true;
} else {
  host.editContext = editContext;
  wireEditor();
  host.focus();
  render();
}

/** Applies the theme the workspace window mirrored, so the page follows the active app theme. */
function applyMirroredTheme(): void {
  document.documentElement.dataset.theme = resolveThemeId(localStorage.getItem(THEME_MIRROR_KEY));
}

applyMirroredTheme();
// A theme change in the workspace window writes the mirror, and the storage event recolors the page.
window.addEventListener('storage', (event) => {
  if (event.key === THEME_MIRROR_KEY) {
    applyMirroredTheme();
  }
});
console.info('[NodeWavenUI] editor window ready');
