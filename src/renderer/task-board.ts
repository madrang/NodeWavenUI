/**
 * The task board: the workarea view over the dispatchable task records. The board lists the
 * records by state group, carries the create form, and holds the review actions. Every control
 * calls the store or the session callbacks of the app, so the board keeps no task state of its own.
 */

import { getWorkarea, type WorkareaView } from './workarea.js';
import { renderMarkdown } from './text/render.js';
import type { TaskDispatchMode, TaskRecord } from '../shared/tasks.js';
import type { TaskStore } from './task-store.js';

/** The deps the board needs beside the store. */
export interface TaskBoardDeps {
  readonly store: TaskStore;
  /** Dispatches one task, through the same path the tasks tool takes. Answers the outcome text. */
  readonly dispatch: (id: string, mode: TaskDispatchMode, sessionFileId: string | null) => Promise<string>;
  /** Activates the chat tab of one session, so Open session jumps to the conversation. */
  readonly openSession: (chatId: number) => void;
  /** Reads the chat sessions a dispatch can bind: file id and title pairs. */
  readonly sessions: () => readonly { fileId: string; title: string }[];
  /** Returns one review to its session with the comment of the user. */
  readonly returnTask: (id: string, comment: string | null) => void;
}

/** The edit state of the board: which card sits in its edit form, and the unsaved drafts that
 * survive a re-render, so a settle elsewhere never eats a typed change. */
interface BoardEditState {
  readonly store: TaskStore;
  editingId: string | null;
  readonly drafts: Map<string, { title: string; description: string; goal: string }>;
  readonly requestRender: () => void;
}

/** The id of the one board view: a second open call only activates it again. */
const VIEW_ID = 'task-board';

/** The state groups of the board, in display order. */
const GROUPS: readonly { readonly label: string; readonly states: readonly string[] }[] = [
  { label: 'Waiting for review', states: ['review'] },
  { label: 'Live', states: ['draft', 'queued', 'running'] },
  { label: 'Settled', states: ['done', 'failed', 'cancelled'] },
];

/** The button variants of the board cards. A push button sits at the right end of its row. */
interface ButtonOptions {
  readonly primary?: boolean;
  readonly danger?: boolean;
  readonly push?: boolean;
}

/** Builds one plain button the board cards use. */
function button(label: string, run: () => void, options: ButtonOptions = {}): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'task-board-button';
  if (options.primary) {
    element.classList.add('primary');
  }
  if (options.danger) {
    element.classList.add('danger');
  }
  if (options.push) {
    element.classList.add('push');
  }
  element.textContent = label;
  element.addEventListener('click', () => {
    run();
  });
  return element;
}

/** Builds the create form of the board. */
function buildCreate(deps: TaskBoardDeps): HTMLElement {
  const form = document.createElement('form');
  form.className = 'task-board-create';
  const title = document.createElement('input');
  title.type = 'text';
  title.placeholder = 'New task title';
  title.required = true;
  const description = document.createElement('textarea');
  description.placeholder = 'The brief the session agent reads (optional)';
  const goal = document.createElement('input');
  goal.type = 'text';
  goal.placeholder = 'Goal: the completion test (optional)';
  const submit = button('Create draft', () => undefined, { primary: true });
  submit.type = 'submit';
  form.append(title, description, goal, submit);
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
  return form;
}

/** Appends the session picker of one draft to the given actions row and answers its Dispatch
 * button, so the caller places the button after its neighbors. Null on a non-draft record. */
function buildDispatch(deps: TaskBoardDeps, task: TaskRecord, actions: HTMLElement): HTMLButtonElement | null {
  if (task.status !== 'draft') {
    return null;
  }
  const sessions = deps.sessions();
  const label = document.createElement('span');
  label.className = 'task-board-label';
  label.textContent = 'Session';
  const select = document.createElement('select');
  select.title = 'The chat session the dispatch binds to. New session opens a fresh chat tab.';
  const fresh = document.createElement('option');
  fresh.value = '';
  fresh.textContent = 'New session';
  select.append(fresh);
  for (const session of sessions) {
    const option = document.createElement('option');
    option.value = session.fileId;
    option.textContent = session.title;
    select.append(option);
  }
  const run = async (): Promise<void> => {
    const mode: TaskDispatchMode = select.value ? 'session' : 'new-session';
    await deps.dispatch(task.id, mode, select.value || null);
  };
  actions.append(label, select);
  return button('Dispatch', () => {
    void run();
  }, { primary: true });
}

/** Builds the edit form of one card: the title, the description, and the goal over the saved
 * draft, with Save and Cancel. The inputs write the draft on every change, so a re-render keeps
 * the typed text. */
function buildEditForm(task: TaskRecord, edit: BoardEditState): HTMLElement {
  const form = document.createElement('form');
  form.className = 'task-board-edit';
  const draft = edit.drafts.get(task.id) ?? {
    title: task.title,
    description: task.description,
    goal: task.goal,
  };
  edit.drafts.set(task.id, draft);
  const title = document.createElement('input');
  title.type = 'text';
  title.value = draft.title;
  title.placeholder = 'Task title';
  const description = document.createElement('textarea');
  description.value = draft.description;
  description.placeholder = 'The brief the session agent reads. Fenced code blocks render highlighted.';
  const goal = document.createElement('input');
  goal.type = 'text';
  goal.value = draft.goal;
  goal.placeholder = 'Goal: the completion test (optional)';
  for (const [input, key] of [[title, 'title'], [description, 'description'], [goal, 'goal']] as const) {
    input.addEventListener('input', () => {
      (draft as unknown as Record<string, string>)[key] = input.value;
    });
  }
  const save = button('Save', () => undefined, { primary: true });
  save.type = 'submit';
  // The submit runs the save for the click and the Enter key alike, and the prevented default
  // keeps the form from navigating the workspace page.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      await edit.store.update(task.id, {
        title: title.value.trim() || task.title,
        description: description.value.trim(),
        goal: goal.value.trim(),
      });
      edit.drafts.delete(task.id);
      edit.editingId = null;
      edit.requestRender();
    })();
  });
  const controls = document.createElement('div');
  controls.className = 'task-board-row';
  controls.append(
    save,
    button('Cancel', () => {
      edit.drafts.delete(task.id);
      edit.editingId = null;
      edit.requestRender();
    }),
  );
  form.append(title, description, goal, controls);
  return form;
}

/** Builds one card of the board. A card in its edit state shows the form alone. */
function buildCard(deps: TaskBoardDeps, task: TaskRecord, edit: BoardEditState): HTMLElement {
  const card = document.createElement('article');
  card.className = `task-board-card ${task.status}`;
  const head = document.createElement('div');
  head.className = 'task-board-card-head';
  const title = document.createElement('h3');
  title.textContent = task.title;
  const status = document.createElement('span');
  status.className = 'task-board-status';
  status.textContent = task.status;
  head.append(title, status);
  card.append(head);
  if (edit.editingId === task.id) {
    card.append(buildEditForm(task, edit));
    return card;
  }
  if (task.description) {
    const body = document.createElement('div');
    body.className = 'task-board-description md-body';
    renderMarkdown(body, task.description);
    card.append(body);
  }
  if (task.goal) {
    const goal = document.createElement('p');
    goal.className = 'task-board-goal';
    goal.textContent = `Goal: ${task.goal}`;
    card.append(goal);
  }
  if (task.result) {
    const result = document.createElement('p');
    result.className = 'task-board-result';
    result.textContent = `Result: ${task.result}`;
    card.append(result);
  }
  const actions = document.createElement('div');
  actions.className = 'task-board-row';
  actions.append(
    button('Edit', () => {
      edit.editingId = task.id;
      edit.requestRender();
    }),
  );
  if (task.status === 'draft' || task.status === 'queued' || task.status === 'running') {
    const dispatch = buildDispatch(deps, task, actions);
    actions.append(
      button('Cancel', () => {
        void deps.store.cancel(task.id, null);
      }, { danger: true, push: true }),
    );
    if (dispatch) {
      actions.append(dispatch);
    }
  }
  if (task.status === 'running' && typeof task.sessionChatId === 'number') {
    const chatId = task.sessionChatId;
    actions.append(
      button('Open session', () => {
        deps.openSession(chatId);
      }),
    );
  }
  if (task.status === 'review') {
    const comment = document.createElement('input');
    comment.type = 'text';
    comment.placeholder = 'Return comment (optional)';
    actions.append(
      comment,
      button('Return', () => {
        deps.returnTask(task.id, comment.value.trim() || null);
      }),
    );
    if (task.sessionChatId) {
      const chatId = task.sessionChatId;
      actions.append(
        button('Open session', () => {
          deps.openSession(chatId);
        }),
      );
    }
    actions.append(
      button('Accept', () => {
        void deps.store.accept(task.id);
      }, { primary: true, push: true }),
    );
  }
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    actions.append(
      button('Remove', () => {
        void deps.store.remove(task.id);
      }, { danger: true, push: true }),
    );
  }
  card.append(actions);
  return card;
}

/**
 * Opens the task board in the center workspace, or activates the open view again.
 *
 * @param deps The store, the dispatch and session callbacks, and the return action.
 * @param focusId The id of one record that opens straight into its edit form, focused on the
 * description, so a task drafted from a code selection takes its purpose at once.
 */
export function openTaskBoardView(deps: TaskBoardDeps, focusId: string | null = null): void {
  getWorkarea().unregister(VIEW_ID);
  const content = document.createElement('div');
  content.className = 'task-board';
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
    label: 'Tasks',
    badge: 'task',
    title: 'The dispatchable task records of the workspace',
    content,
    onClose: () => {
      dispose();
      getWorkarea().unregister(VIEW_ID);
      content.remove();
    },
  };
  const rerender = (): void => {
    const records = deps.store.list();
    const sections: HTMLElement[] = [buildCreate(deps)];
    for (const group of GROUPS) {
      const members = records.filter((task) => group.states.includes(task.status));
      if (members.length === 0) {
        continue;
      }
      const section = document.createElement('section');
      section.className = 'task-board-group';
      const head = document.createElement('h2');
      head.textContent = `${group.label} (${members.length})`;
      section.append(head);
      for (const task of members) {
        section.append(buildCard(deps, task, edit));
      }
      sections.push(section);
    }
    if (sections.length === 1) {
      const empty = document.createElement('p');
      empty.className = 'task-board-empty';
      empty.textContent = 'No task exists yet. Create one above, or let an agent call the tasks tool.';
      sections.push(empty);
    }
    content.replaceChildren(...sections);
  };
  dispose = deps.store.subscribe(rerender);
  rerender();
  getWorkarea().register(VIEW_ID, view);
  if (focusId) {
    content.querySelector<HTMLElement>('.task-board-edit textarea')?.focus();
  }
}
