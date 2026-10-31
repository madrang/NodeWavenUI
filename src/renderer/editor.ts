/**
 * The Editor window: a plain-text editor built on the EditContext API, driven through the
 * `nodewavenEditor` page global. One document lives in one window (see docs/editor.md).
 * The EditContext instance holds the text and the selection. The page renders the text into
 * one DOM text node after every change, so the native caret, the mouse selection, and the
 * agent calls share one state. The buffer and the view stay separate: a later layer can
 * restyle the rendered text without touching the edit logic.
 */

import './edit-context.js';
import { requireElement } from './dom.js';
import { resolveThemeId, THEME_MIRROR_KEY } from './theme.js';

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
  if (editContext === null) {
    throw new Error('The EditContext API is not available in this Chromium build. The editor needs Chromium 133 or later.');
  }
  return editContext;
}

/** The code unit of the line break. */
const NEWLINE = 10;

/** The text node inside the host. One node holds the whole document, so an offset maps straight onto it. */
let textNode: Text | null = null;

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
  if (snapshot === undefined) {
    return 'nothing to undo';
  }
  redoStack.push(committed);
  applyState(snapshot);
  return `undone, ${undoStack.length} steps left`;
}

/** Steps one stored state forward again. Answers with a confirmation for the caller. */
function redo(): string {
  const snapshot = redoStack.pop();
  if (snapshot === undefined) {
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
  if (textNode === null) {
    return null;
  }
  const context = ctx();
  const range = document.createRange();
  range.setStart(textNode, Math.min(context.selectionStart, context.selectionEnd));
  range.setEnd(textNode, Math.max(context.selectionStart, context.selectionEnd));
  const rect = range.getClientRects()[0];
  if (rect !== undefined) {
    return new DOMRect(rect.x, rect.y, Math.max(rect.width, 1), rect.height);
  }
  // A caret at a line boundary can carry no rectangle. The character before it gives the position.
  const start = Math.min(context.selectionStart, context.selectionEnd);
  if (start > 0) {
    range.setStart(textNode, start - 1);
    range.setEnd(textNode, start);
    const before = range.getClientRects()[0];
    if (before !== undefined) {
      return new DOMRect(before.right, before.y, Math.max(before.width, 1), before.height);
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
  if (caret !== null) {
    context.updateSelectionBounds(caret);
  }
}

/** Scrolls the caret into view when it sits outside the visible area. */
function scrollCaretIntoView(): void {
  const caret = caretRect();
  if (caret === null) {
    return;
  }
  const viewport = scrollArea.getBoundingClientRect();
  if (caret.bottom > viewport.bottom) {
    scrollArea.scrollTop += caret.bottom - viewport.bottom;
  } else if (caret.top < viewport.top) {
    scrollArea.scrollTop -= viewport.top - caret.top;
  }
}

/** Maps one DOM selection position onto a text offset. Positions outside the text node map to null. */
function domPositionToOffset(node: Node | null, offset: number): number | null {
  if (textNode === null || node === null) {
    return null;
  }
  if (node === textNode) {
    return Math.min(offset, textNode.length);
  }
  if (node === host) {
    // The browser placed the selection on the host itself, before or after the text node.
    return offset === 0 ? 0 : textNode.length;
  }
  return null;
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
  if (textNode === null) {
    return;
  }
  const context = ctx();
  const selection = document.getSelection();
  if (selection === null) {
    return;
  }
  const range = document.createRange();
  range.setStart(textNode, context.selectionStart);
  range.setEnd(textNode, context.selectionEnd);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The client rectangle of the character at an offset. A one-character look back covers line boundaries. */
function charRectAt(offset: number): DOMRect | null {
  if (textNode === null) {
    return null;
  }
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.setEnd(textNode, Math.min(offset + 1, textNode.length));
  let rect = range.getClientRects()[0];
  if (rect === undefined && offset > 0) {
    range.setStart(textNode, offset - 1);
    range.setEnd(textNode, offset);
    rect = range.getClientRects()[0];
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
    if (rect !== null) {
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
  if (registry === undefined) {
    return;
  }
  if (compositionRange === null || textNode === null) {
    registry.delete('ime-composition');
    return;
  }
  const range = document.createRange();
  range.setStart(textNode, Math.min(compositionRange.start, textNode.length));
  range.setEnd(textNode, Math.min(compositionRange.end, textNode.length));
  registry.set('ime-composition', new Highlight(range));
}

/** Renders the editor state: the text, the selection, the gutter, the status bar, and the input method bounds. */
function render(): void {
  const context = ctx();
  const text = context.text;
  if (textNode === null) {
    textNode = document.createTextNode(text);
    host.replaceChildren(textNode);
  } else {
    textNode.data = text;
  }
  renderSelection();
  renderGutter(text);
  renderStatus(text);
  renderComposition();
  notifyBounds();
  scrollCaretIntoView();
  committed = { text, selectionStart: context.selectionStart, selectionEnd: context.selectionEnd };
}

/** Applies a title: the title bar text, its visibility, and the window title. */
function applyTitle(title: string): void {
  titleBar.textContent = title;
  titleBar.hidden = title.length === 0;
  document.title = title.length > 0 ? `${title} — NodeWavenUI Editor` : 'Editor — NodeWavenUI';
}

/** Reads the optional title from the setText options object. */
function readTitleOption(options: unknown): string | undefined {
  if (options === undefined || options === null) {
    return undefined;
  }
  if (typeof options !== 'object') {
    throw new Error('The editor options must be an object: { title }.');
  }
  const title = (options as Record<string, unknown>)['title'];
  if (title === undefined) {
    return undefined;
  }
  if (typeof title !== 'string') {
    throw new Error('The editor title must be a string.');
  }
  return title;
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

/** Attaches every editor event. The page calls it once, after the context attached to the host. */
function wireEditor(): void {
  const context = ctx();

  // The context applied the change already. The page renders the new state and stores the old one as one undo step.
  context.addEventListener('textupdate', () => {
    recordUndoStep();
    render();
  });

  // The input method asks where the composed characters sit, so it can place its candidate window.
  context.addEventListener('characterboundsupdate', (event) => {
    if (textNode === null) {
      return;
    }
    const bounds: DOMRect[] = [];
    for (let offset = event.rangeStart; offset < event.rangeEnd && offset < textNode.length; offset += 1) {
      const rect = charRectAt(offset);
      bounds.push(rect ?? new DOMRect(0, 0, 0, 0));
    }
    context.updateCharacterBounds(event.rangeStart, bounds);
  });

  context.addEventListener('textformatupdate', (event) => {
    const format = event.getTextFormats()[0];
    if (format !== undefined) {
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
    if (offsets === null) {
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
  /** Replaces the whole document. The options carry an optional title. The undo history starts over. */
  setText: (text: unknown, options?: unknown): string => {
    if (typeof text !== 'string') {
      throw new Error('The editor text must be a string.');
    }
    const title = readTitleOption(options);
    if (title !== undefined) {
      applyTitle(title);
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

if (editContext === null) {
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
