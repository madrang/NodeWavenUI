/**
 * The task board: the workarea view over the dispatchable task records. The board lists the
 * records by state group, carries the create form, and holds the review actions. Every control
 * calls the store or the session callbacks of the app, so the board keeps no task state of its own.
 */

import { getWorkarea, type WorkareaView } from './workarea.js';
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

/** The id of the one board view: a second open call only activates it again. */
const VIEW_ID = 'task-board';

/** The state groups of the board, in display order. */
const GROUPS: readonly { readonly label: string; readonly states: readonly string[] }[] = [
  { label: 'Waiting for review', states: ['review'] },
  { label: 'Live', states: ['draft', 'queued', 'running'] },
  { label: 'Settled', states: ['done', 'failed', 'cancelled'] },
];

/** The button variants of the board cards. */
interface ButtonOptions {
  readonly primary?: boolean;
  readonly danger?: boolean;
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
      description: description.value.trim() || null,
      goal: goal.value.trim() || null,
      origin: 'user',
      originChatId: null,
      parentTaskId: null,
      blockedBy: [],
    });
  });
  return form;
}

/** Builds the dispatch controls of one draft or the open line of one record. */
function buildDispatch(deps: TaskBoardDeps, task: TaskRecord): HTMLElement {
  const row = document.createElement('div');
  row.className = 'task-board-row';
  if (task.status !== 'draft') {
    return row;
  }
  const sessions = deps.sessions();
  const select = document.createElement('select');
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
  row.append(select, button('Dispatch', () => {
    void run();
  }, { primary: true }));
  return row;
}

/** Builds one card of the board. */
function buildCard(deps: TaskBoardDeps, task: TaskRecord): HTMLElement {
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
  if (task.description) {
    const description = document.createElement('p');
    description.textContent = task.description;
    card.append(description);
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
  if (task.status === 'draft' || task.status === 'queued' || task.status === 'running') {
    actions.append(buildDispatch(deps, task));
    actions.append(
      button('Cancel', () => {
        void deps.store.cancel(task.id, null);
      }, { danger: true }),
    );
  }
  if (task.status === 'running' && task.sessionChatId !== null) {
    const chatId = task.sessionChatId;
    actions.append(
      button('Open session', () => {
        deps.openSession(chatId);
      }),
    );
  }
  if (task.status === 'review') {
    actions.append(
      button('Accept', () => {
        void deps.store.accept(task.id);
      }, { primary: true }),
    );
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
  }
  card.append(actions);
  return card;
}

/**
 * Opens the task board in the center workspace, or activates the open view again.
 *
 * @param deps The store, the dispatch and session callbacks, and the return action.
 */
export function openTaskBoardView(deps: TaskBoardDeps): void {
  getWorkarea().unregister(VIEW_ID);
  const content = document.createElement('div');
  content.className = 'task-board';
  /** Drops the store subscription of this view. */
  let dispose = (): void => {};
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
        section.append(buildCard(deps, task));
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
}
