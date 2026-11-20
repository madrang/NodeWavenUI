/**
 * The task board view of the workarea, over the dispatchable task records. The static skeleton
 * — the create form and the groups container — lives in the view folder as `template.html`
 * with `${token}` placeholders, and the styles live beside it as `styles.css`; this module
 * loads both on open (the workarea registers a view with a built element), wires the create
 * form against the store, and renders the record groups through the builders of
 * `src/renderer/task-board.ts`. The skeleton stays mounted between renders, so a typed create
 * draft survives a store event.
 */

import { getWorkarea, type WorkareaView } from '../../workarea.js';
import { localizeHTML, translateMessage } from '../../locale/index.js';
import { adoptStyles, loadTemplate } from '../../ui/template.js';
import { buildBoardSections, type BoardEditState, type TaskBoardDeps } from '../../task-board.js';

/** The id of the one board view: a second open call only activates it again. */
const VIEW_ID = 'task-board';

/**
 * Opens the task board in the center workspace, or activates the open view again.
 *
 * @param deps The store, the dispatch and session callbacks, and the return action.
 * @param focusId The id of one record that opens straight into its edit form, focused on the
 * description, so a task drafted from a code selection takes its purpose at once.
 * @throws Error when an asset fails to load.
 */
export async function openTaskBoardView(deps: TaskBoardDeps, focusId: string | null = null): Promise<void> {
  getWorkarea().unregister(VIEW_ID);
  const [template] = await Promise.all([
    loadTemplate('views/task-board/template.html'),
    adoptStyles('views/task-board/styles.css'),
  ]);
  localizeHTML(template.content);
  const content = document.createElement('div');
  content.className = 'task-board';
  content.append(template.content);
  const groups = content.querySelector<HTMLElement>('.task-board-groups');
  if (!groups) {
    throw new Error('The task board template holds no groups container.');
  }
  wireCreateForm(content, deps);
  /** Drops the store subscription of this view. */
  let dispose = (): void => {};
  const edit: BoardEditState = {
    store: deps.store,
    editingId: focusId,
    drafts: new Map(),
    requestRender: (): void => {
      rerender();
    },
  };
  const view: WorkareaView = {
    label: translateMessage('tasks', 'viewLabel'),
    badge: 'task',
    title: translateMessage('tasks', 'viewTitle'),
    content,
    onClose: () => {
      dispose();
      getWorkarea().unregister(VIEW_ID);
      content.remove();
    },
  };
  const rerender = (): void => {
    groups.replaceChildren(...buildBoardSections(deps, edit));
  };
  dispose = deps.store.subscribe(rerender);
  rerender();
  getWorkarea().register(VIEW_ID, view);
  if (focusId) {
    content.querySelector<HTMLElement>('.task-board-edit textarea')?.focus();
  }
}

/** Wires the create form of the template against the store: a trimmed title creates a draft. */
function wireCreateForm(content: HTMLElement, deps: TaskBoardDeps): void {
  const form = content.querySelector<HTMLFormElement>('.task-board-create');
  const title = content.querySelector<HTMLInputElement>('.task-create-title');
  const description = content.querySelector<HTMLTextAreaElement>('.task-create-brief');
  const goal = content.querySelector<HTMLInputElement>('.task-create-goal');
  if (!form || !title || !description || !goal) {
    throw new Error('The task board template holds an incomplete create form.');
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const trimmed = title.value.trim();
    if (!trimmed) {
      return;
    }
    void deps.store.create({
      title: trimmed,
      description: description.value.trim(),
      goal: goal.value.trim(),
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    });
  });
}
