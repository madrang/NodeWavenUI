/**
 * The task board building blocks: the record cards, their edit and dispatch forms, and the
 * state groups. The view folder (`views/task-board/`) owns the static skeleton — the create
 * form and the groups container — and mounts these builders over it. Every control calls the
 * store or the session callbacks of the app, so the board keeps no task state of its own.
 */

import { renderMarkdown } from './text/render.js';
import { translateMessage } from './locale/index.js';
import { TASK_STATUSES, type TaskDispatchMode, type TaskRecord, type TaskStatus } from '../shared/tasks.js';
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
 * survive a re-render, so a settle elsewhere never eats a typed change. The status choice of one
 * settled record rides the draft: null keeps the stored status. */
export interface BoardEditState {
  readonly store: TaskStore;
  editingId: string | null;
  readonly drafts: Map<string, { title: string; description: string; goal: string; status: TaskStatus | null }>;
  readonly requestRender: () => void;
}

/** The state groups of the board, in display order, with their dictionary keys. */
const GROUPS: readonly { readonly labelKey: 'groupReview' | 'groupLive' | 'groupSettled'; readonly states: readonly string[] }[] = [
  { labelKey: 'groupReview', states: ['review'] },
  { labelKey: 'groupLive', states: ['draft', 'queued', 'running'] },
  { labelKey: 'groupSettled', states: ['done', 'failed', 'cancelled'] },
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

/** Appends the session picker of one draft to the given actions row and answers its Dispatch
 * button, so the caller places the button after its neighbors. Null on a non-draft record. */
function buildDispatch(deps: TaskBoardDeps, task: TaskRecord, actions: HTMLElement): HTMLButtonElement | null {
  if (task.status !== 'draft') {
    return null;
  }
  const sessions = deps.sessions();
  const label = document.createElement('span');
  label.className = 'task-board-label';
  label.textContent = translateMessage('tasks', 'sessionLabel');
  const select = document.createElement('select');
  select.title = translateMessage('tasks', 'sessionTitle');
  const fresh = document.createElement('option');
  fresh.value = '';
  fresh.textContent = translateMessage('tasks', 'sessionNew');
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
  return button(translateMessage('tasks', 'dispatch'), () => {
    void run();
  }, { primary: true });
}

/** Builds the status badge of one card in its edit state: the badge becomes a select over every
 * status, so the user hand-overrides the record. The choice rides the edit draft and applies on
 * Save. */
function buildStatusChoice(task: TaskRecord, edit: BoardEditState): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'task-board-status';
  select.title = translateMessage('tasks', 'statusTitle');
  for (const status of TASK_STATUSES) {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    select.append(option);
  }
  select.value = edit.drafts.get(task.id)?.status ?? task.status;
  select.addEventListener('change', () => {
    const draft = edit.drafts.get(task.id) ?? {
      title: task.title,
      description: task.description,
      goal: task.goal,
      status: null as TaskStatus | null,
    };
    draft.status = select.value as TaskStatus;
    edit.drafts.set(task.id, draft);
  });
  return select;
}

/** Builds the edit form of one card: the title, the description, and the goal over the saved
 * draft, with Save and Cancel. The inputs write the draft on every change, so a re-render keeps
 * the typed text. The status choice of the head select applies with the same Save. */
function buildEditForm(task: TaskRecord, edit: BoardEditState): HTMLElement {
  const form = document.createElement('form');
  form.className = 'task-board-edit';
  const draft = edit.drafts.get(task.id) ?? {
    title: task.title,
    description: task.description,
    goal: task.goal,
    status: null as TaskStatus | null,
  };
  edit.drafts.set(task.id, draft);
  const title = document.createElement('input');
  title.type = 'text';
  title.value = draft.title;
  title.placeholder = translateMessage('tasks', 'editTitlePlaceholder');
  const description = document.createElement('textarea');
  description.value = draft.description;
  description.placeholder = translateMessage('tasks', 'editBriefPlaceholder');
  const goal = document.createElement('input');
  goal.type = 'text';
  goal.value = draft.goal;
  goal.placeholder = translateMessage('tasks', 'editGoalPlaceholder');
  for (const [input, key] of [[title, 'title'], [description, 'description'], [goal, 'goal']] as const) {
    input.addEventListener('input', () => {
      (draft as unknown as Record<string, string>)[key] = input.value;
    });
  }
  const save = button(translateMessage('tasks', 'save'), () => undefined, { primary: true });
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
        ...(draft.status && draft.status !== task.status ? { status: draft.status } : {}),
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
    button(translateMessage('tasks', 'cancel'), () => {
      edit.drafts.delete(task.id);
      edit.editingId = null;
      edit.requestRender();
    }),
  );
  form.append(title, description, goal, controls);
  return form;
}

/** Builds one card of the board. A card in its edit state shows the form alone, and its status
 * badge becomes the status select. */
function buildCard(deps: TaskBoardDeps, task: TaskRecord, edit: BoardEditState): HTMLElement {
  const card = document.createElement('article');
  card.className = `task-board-card ${task.status}`;
  const head = document.createElement('div');
  head.className = 'task-board-card-head';
  const title = document.createElement('h3');
  title.textContent = task.title;
  head.append(title);
  if (edit.editingId === task.id) {
    head.append(buildStatusChoice(task, edit));
  } else {
    const status = document.createElement('span');
    status.className = 'task-board-status';
    status.textContent = task.status;
    head.append(status);
  }
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
    goal.textContent = translateMessage('tasks', 'goalPrefix', { goal: task.goal });
    card.append(goal);
  }
  if (task.result) {
    const result = document.createElement('p');
    result.className = 'task-board-result';
    result.textContent = translateMessage('tasks', 'resultPrefix', { result: task.result });
    card.append(result);
  }
  const actions = document.createElement('div');
  actions.className = 'task-board-row';
  actions.append(
    button(translateMessage('tasks', 'edit'), () => {
      edit.editingId = task.id;
      edit.requestRender();
    }),
  );
  if (task.status === 'draft' || task.status === 'queued' || task.status === 'running') {
    const dispatch = buildDispatch(deps, task, actions);
    actions.append(
      button(translateMessage('tasks', 'cancel'), () => {
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
      button(translateMessage('tasks', 'openSession'), () => {
        deps.openSession(chatId);
      }),
    );
  }
  if (task.status === 'review') {
    const comment = document.createElement('input');
    comment.type = 'text';
    comment.placeholder = translateMessage('tasks', 'returnCommentPlaceholder');
    actions.append(
      comment,
      button(translateMessage('tasks', 'returnAction'), () => {
        deps.returnTask(task.id, comment.value.trim() || null);
      }),
    );
    if (task.sessionChatId) {
      const chatId = task.sessionChatId;
      actions.append(
        button(translateMessage('tasks', 'openSession'), () => {
          deps.openSession(chatId);
        }),
      );
    }
    actions.append(
      button(translateMessage('tasks', 'accept'), () => {
        void deps.store.accept(task.id);
      }, { primary: true, push: true }),
    );
  }
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    actions.append(
      button(translateMessage('tasks', 'remove'), () => {
        void deps.store.remove(task.id);
      }, { danger: true, push: true }),
    );
  }
  card.append(actions);
  return card;
}

/**
 * Builds the state group sections of the board over the current records: one section per group
 * that holds members, and the empty note alone when no task exists.
 *
 * @param deps The store, the dispatch and session callbacks, and the return action.
 * @param edit The edit state of the board, shared with the view that mounts the sections.
 * @returns The sections of one board render.
 */
export function buildBoardSections(deps: TaskBoardDeps, edit: BoardEditState): HTMLElement[] {
  const records = deps.store.list();
  const sections: HTMLElement[] = [];
  for (const group of GROUPS) {
    const members = records.filter((task) => group.states.includes(task.status));
    if (members.length === 0) {
      continue;
    }
    const section = document.createElement('section');
    section.className = 'task-board-group';
    const head = document.createElement('h2');
    head.textContent = translateMessage('tasks', 'groupHeading', {
      label: translateMessage('tasks', group.labelKey),
      count: String(members.length),
    });
    section.append(head);
    for (const task of members) {
      section.append(buildCard(deps, task, edit));
    }
    sections.push(section);
  }
  if (sections.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'task-board-empty';
    empty.textContent = translateMessage('tasks', 'empty');
    sections.push(empty);
  }
  return sections;
}
