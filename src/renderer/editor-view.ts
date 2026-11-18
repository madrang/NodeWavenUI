/**
 * The editor view of the center workspace: one workarea tab that hosts the editor page with one
 * file loaded. The rail files tree opens it. The view reads the file text and seeds the editor
 * buffer through the `nodewavenEditor` page global of the same-origin iframe, so the buffer edits
 * stay in the editor page until the view saves them through the bridge fs. The bar above the
 * editor carries the save and the task-from-selection actions: the save writes the buffer back to
 * the file, and the task action turns the selection into a draft task record on the board. One
 * shared tab switches its file, and CTRL opens the file in its own tab, like the patch review.
 */

import { getWorkarea, type WorkareaView } from './workarea.js';
import { readTextFile, writeTextFile } from './file-system.js';
import type { TaskStore } from './task-store.js';

/** The address of the editor page, served from the renderer origin of the workspace page. */
const EDITOR_PAGE = 'app://renderer/editor.html';

/** The id of the one shared editor tab. A second file on the shared tab replaces the first. */
const SHARED_VIEW_ID = 'editor';

/** The deps the task-from-selection action needs. Without them the bar shows the save only. */
export interface EditorViewDeps {
  /** The task store that holds the draft the selection becomes. */
  readonly store: TaskStore;
  /** Opens the task board, so the user edits and dispatches the new draft. */
  readonly openBoard: () => void;
}

/** The editor page global the view drives. */
type EditorPage = Window & {
  nodewavenEditor?: {
    setText: (text: string, options?: { title?: string }) => string;
    getText: () => string;
    getSelection: () => { readonly start: number; readonly end: number };
  };
};

/** Reads the last path segment of one file path, for the tab label. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? path;
}

/** Reads the fence language of one file path: its extension, or an empty string. */
function fenceLanguage(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Opens one file in the editor view of the center workspace.
 *
 * @param path The absolute path of the file.
 * @param separateTab True to open the file in its own tab instead of the shared editor tab.
 * @param deps The task store and the board opener, for the task-from-selection action. Optional.
 */
export async function openEditorView(
  path: string,
  separateTab: boolean,
  deps: EditorViewDeps | null = null,
): Promise<void> {
  const text = await readTextFile(path);
  // eslint-disable-next-line local/prefer-truthiness -- an empty file reads as an empty string, only a failed read refuses the view
  if (text === null) {
    console.warn(`[NodeWavenUI] the file "${path}" could not be read. The editor view stays closed.`);
    return;
  }
  const workarea = getWorkarea();
  const viewId = separateTab ? `editor:${path}` : SHARED_VIEW_ID;
  workarea.unregister(viewId);
  const content = document.createElement('div');
  content.className = 'editor-view';
  const name = baseName(path);

  const status = document.createElement('span');
  status.className = 'editor-view-status';
  let savedText = text;

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'editor-view-button';
  save.textContent = 'Save';
  save.title = 'Write the buffer back to the file. Ctrl+S inside the editor does the same.';
  save.addEventListener('click', () => {
    void runSave();
  });

  const frame = document.createElement('iframe');
  frame.src = EDITOR_PAGE;
  /** Runs one save: the buffer text lands in the file, and the dirty mark clears. */
  const runSave = async (): Promise<void> => {
    const editor = (frame.contentWindow as EditorPage | null)?.nodewavenEditor;
    if (!editor) {
      return;
    }
    const current = editor.getText();
    if (current === savedText) {
      status.textContent = 'Nothing to save.';
      return;
    }
    try {
      await writeTextFile(path, current);
      savedText = current;
      workarea.setLabel(viewId, name);
      status.textContent = `Saved ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = `The save failed: ${message}`;
    }
  };

  frame.addEventListener('load', () => {
    const page = frame.contentWindow as EditorPage | null;
    try {
      page?.nodewavenEditor?.setText(text, { title: name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the editor view of "${path}" could not seed its buffer: ${message}`);
    }
  });

  /** Turns the selection of the editor into one draft task and opens the board. */
  const taskFromSelection = async (): Promise<void> => {
    const page = frame.contentWindow as EditorPage | null;
    const editor = page?.nodewavenEditor;
    if (!editor || !deps) {
      return;
    }
    const buffer = editor.getText();
    const selection = editor.getSelection();
    const snippet = buffer.slice(selection.start, selection.end);
    if (snippet.trim().length === 0) {
      status.textContent = 'Select text in the editor first.';
      return;
    }
    const lineStart = buffer.slice(0, selection.start).split('\n').length;
    const lineEnd = lineStart + snippet.split('\n').length - 1;
    const range = lineStart === lineEnd ? `${lineStart}` : `${lineStart}-${lineEnd}`;
    const language = fenceLanguage(path);
    const record = await deps.store.create({
      title: `${name}:${range}`,
      description: `File: ${path} lines ${range}\n\n\`\`\`${language}\n${snippet}\n\`\`\``,
      goal: null,
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    });
    status.textContent = record ? `Task ${record.id.slice(0, 8)} drafted from the selection.` : 'The task could not be created.';
    if (record) {
      deps.openBoard();
    }
  };

  // The editor page notes its changes and its Ctrl+S to its framing view, same-origin.
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) {
      return;
    }
    const type = (event.data as { readonly type?: unknown } | null)?.type;
    if (type === 'nodewavenui-editor-save') {
      void runSave();
      return;
    }
    if (type === 'nodewavenui-editor-changed') {
      workarea.setLabel(viewId, `${name} •`);
    }
  };
  window.addEventListener('message', onMessage);

  const bar = document.createElement('div');
  bar.className = 'editor-view-bar';
  bar.append(save);
  if (deps) {
    const task = document.createElement('button');
    task.type = 'button';
    task.className = 'editor-view-button';
    task.textContent = 'Task from selection';
    task.title = 'Draft a task record that carries the selected code with its file and lines, then open the board.';
    task.addEventListener('click', () => {
      void taskFromSelection();
    });
    bar.append(task);
  }
  bar.append(status);
  content.append(bar, frame);
  const view: WorkareaView = {
    label: name,
    badge: 'file',
    title: path,
    content,
    onClose: () => {
      window.removeEventListener('message', onMessage);
      getWorkarea().unregister(viewId);
      content.remove();
    },
  };
  workarea.register(viewId, view);
}
