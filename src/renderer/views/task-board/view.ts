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
import {
  buildBoardSections,
  fillCategoryFilter,
  fillPrioritySelect,
  fillTemplateSelect,
  readCapInput,
  readLines,
  type BoardEditState,
  type TaskBoardDeps,
} from '../../task-board.js';
import {
  TASK_MIN_TOKEN_CAP,
  TASK_MIN_TURN_CAP,
  TASK_PRIORITY_DEFAULT,
  type TaskTemplate,
} from '../../../shared/tasks.js';

/** The id of the one board view: a second open call only activates it again. */
const VIEW_ID = 'task-board';

/** The board that is open: the handle that brings it to the front on one record. Null while no
 * board is open. The close of the tab clears it. */
let openBoard: { focus(focusId: string | null): void } | null = null;

/** The build of a board that runs, so two quick calls build one board. */
let opening: Promise<void> | null = null;

/**
 * Opens the task board in the center workspace. A board that is open comes to the front on the
 * record the caller names, so the page holds one board at a time: each board keeps one store
 * subscription, and the close of its tab ends that subscription and takes its content out of the
 * page.
 *
 * @param deps The store, the dispatch and session callbacks, and the return action.
 * @param focusId The id of one record that opens straight into its edit form, focused on the
 * description, so a task drafted from a code selection takes its purpose at once.
 * @throws Error when an asset fails to load.
 */
export async function openTaskBoardView(deps: TaskBoardDeps, focusId: string | null = null): Promise<void> {
  if (!openBoard) {
    // A call that lands while a first one builds waits for that board.
    const building = opening ?? buildBoard(deps);
    opening = building;
    try {
      await building;
    } finally {
      opening = null;
    }
  }
  openBoard?.focus(focusId);
}

/** Builds the one board view and registers it. The handle stays until the tab closes. */
async function buildBoard(deps: TaskBoardDeps): Promise<void> {
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
  const refreshTemplates = wireCreateForm(content, deps);
  const categoryFilter = content.querySelector<HTMLSelectElement>('.task-category-filter');
  if (!categoryFilter) {
    throw new Error('The task board template holds no category filter.');
  }
  /** Ends the store subscription and the session list subscription of this view. */
  let dispose = (): void => {};
  let disposeSessions = (): void => {};
  const edit: BoardEditState = {
    store: deps.store,
    editingId: null,
    categoryFilter: '',
    drafts: new Map(),
    answers: new Map(),
    requestRender: (): void => {
      rerender();
    },
  };
  categoryFilter.addEventListener('change', () => {
    edit.categoryFilter = categoryFilter.value;
    rerender();
  });
  const rerender = (): void => {
    // The filter and the template list follow the store, and they keep the choice of the user.
    fillCategoryFilter(categoryFilter, deps.store, edit.categoryFilter);
    refreshTemplates();
    // An answer in progress keeps its field: the rebuild hands the focus back to it.
    const answering = Boolean(document.activeElement?.classList.contains('task-ask-input'));
    groups.replaceChildren(...buildBoardSections(deps, edit));
    const field = answering ? groups.querySelector<HTMLInputElement>('.task-ask-input') : null;
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  };
  const view: WorkareaView = {
    label: translateMessage('tasks', 'viewLabel'),
    badge: 'task',
    title: translateMessage('tasks', 'viewTitle'),
    content,
    onClose: () => {
      // The close of the tab ends both subscriptions, forgets the board, and takes its content out of the page.
      dispose();
      disposeSessions();
      openBoard = null;
      getWorkarea().unregister(VIEW_ID);
      content.remove();
    },
  };
  openBoard = {
    focus: (target: string | null): void => {
      // A call that names no record keeps the edit form that is open.
      edit.editingId = target ?? edit.editingId;
      // The register call activates a view that exists, and mounts one that lost its tab.
      getWorkarea().register(VIEW_ID, view);
      rerender();
      if (target) {
        content.querySelector<HTMLElement>('.task-board-edit textarea')?.focus();
      }
    },
  };
  dispose = deps.store.subscribe(rerender);
  // A chat that opens or closes changes the sessions the cards offer.
  disposeSessions = deps.subscribeSessions(rerender);
  rerender();
  getWorkarea().register(VIEW_ID, view);
}

/** Wires the create form of the template against the store: a trimmed title creates a draft. A cap
 * field takes a whole number above zero, an empty field means no cap, and the time limit reads in
 * minutes. A template of the picker fills the fields of the form, which stay editable.
 *
 * @returns The refill of the template list, for each render of the view.
 */
function wireCreateForm(content: HTMLElement, deps: TaskBoardDeps): () => void {
  const form = content.querySelector<HTMLFormElement>('.task-board-create');
  const template = content.querySelector<HTMLSelectElement>('.task-create-template');
  const templateRemove = content.querySelector<HTMLButtonElement>('.task-template-remove');
  const title = content.querySelector<HTMLInputElement>('.task-create-title');
  const description = content.querySelector<HTMLTextAreaElement>('.task-create-brief');
  const goal = content.querySelector<HTMLInputElement>('.task-create-goal');
  const goals = content.querySelector<HTMLTextAreaElement>('.task-create-goals');
  const category = content.querySelector<HTMLInputElement>('.task-create-category');
  const tokens = content.querySelector<HTMLInputElement>('.task-create-tokens');
  const turns = content.querySelector<HTMLInputElement>('.task-create-turns');
  const timeout = content.querySelector<HTMLInputElement>('.task-create-timeout');
  const priority = content.querySelector<HTMLSelectElement>('.task-create-priority');
  if (
    !form || !template || !templateRemove || !title || !description || !goal || !goals || !category ||
    !tokens || !turns || !timeout || !priority
  ) {
    throw new Error('The task board template holds an incomplete create form.');
  }
  // The token budget and the round budget take the smallest caps a record takes. The form refuses a
  // smaller one before it sends.
  tokens.min = String(TASK_MIN_TOKEN_CAP);
  turns.min = String(TASK_MIN_TURN_CAP);
  fillPrioritySelect(priority, TASK_PRIORITY_DEFAULT);
  const pickedTemplate = (): TaskTemplate | undefined =>
    deps.store.templates().find((candidate) => candidate.id === template.value);
  /** Refills the template list, and keeps the template the user picked while it exists. */
  const refreshTemplates = (): void => {
    const selected = template.value;
    fillTemplateSelect(template, deps.store);
    template.value = [...template.options].some((option) => option.value === selected) ? selected : '';
  };
  refreshTemplates();
  template.addEventListener('change', () => {
    const picked = pickedTemplate();
    if (picked) {
      title.value = picked.title;
      description.value = picked.description;
      goal.value = picked.goal;
      goals.value = picked.goals.join('\n');
      category.value = picked.category;
    }
  });
  templateRemove.addEventListener('click', () => {
    if (template.value) {
      deps.removeTemplate(template.value);
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const trimmed = title.value.trim();
    if (!trimmed) {
      return;
    }
    const minutes = readCapInput(timeout.value);
    // The plan of the picked template rides along: the create form holds no field for it.
    const picked = pickedTemplate();
    void deps.store.create({
      title: trimmed,
      description: description.value.trim(),
      goal: goal.value.trim(),
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
      maxTokens: readCapInput(tokens.value),
      maxTurns: readCapInput(turns.value),
      timeoutMs: minutes ? minutes * 60_000 : null,
      priority: Number(priority.value),
      goals: readLines(goals.value),
      plan: picked?.plan ?? [],
      category: category.value.trim(),
    });
  });
  // Each render of the view refills the list, so a saved or removed template shows at once.
  return refreshTemplates;
}
