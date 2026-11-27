/**
 * The task board building blocks: the record cards, their edit and dispatch forms, and the
 * state groups. The view folder (`views/task-board/`) owns the static skeleton — the create
 * form and the groups container — and mounts these builders over it. Every control calls the
 * store or the session callbacks of the app, so the board keeps no task state of its own.
 */

import { renderMarkdown } from './text/render.js';
import { translateMessage } from './locale/index.js';
import { buildTaskAskCard } from './chat-cards/render.js';
import {
  TASK_MIN_TOKEN_CAP,
  TASK_MIN_TURN_CAP,
  TASK_PRIORITY_DEFAULT,
  TASK_PRIORITY_MAX,
  TASK_STATUSES,
  taskEvidenceLabel,
  taskIsLive,
  type TaskDispatchMode,
  type TaskRecord,
  type TaskStatus,
} from '../shared/tasks.js';
import type { TaskStore } from './task-store.js';

/** The deps the board needs beside the store. */
export interface TaskBoardDeps {
  readonly store: TaskStore;
  /** Dispatches one task, through the same path the tasks tool takes: the record joins the queue,
   * then its session starts. A refusal reaches the log of the app. */
  readonly dispatch: (id: string, mode: TaskDispatchMode, sessionFileId: string | null) => void;
  /** Returns one failed task and the children it failed to the queue, on the named session. A
   * refusal reaches the log of the app. */
  readonly retry: (id: string, mode: TaskDispatchMode, sessionFileId: string | null) => void;
  /** Tells the board that the list of the chat sessions changed: a chat opened or closed. The
   * session pickers of the cards read that list. Answers the end of the subscription. */
  readonly subscribeSessions: (listener: () => void) => () => void;
  /** Opens a new chat that waits for one draft task. The send of that chat dispatches the task. */
  readonly openTaskChat: (taskId: string) => void;
  /** Activates the chat tab of one session, so Open session jumps to the conversation. */
  readonly openSession: (chatId: number) => void;
  /** Reads the chat sessions a dispatch can bind: file id and title pairs. */
  readonly sessions: () => readonly { fileId: string; title: string }[];
  /** Returns one review to its session with the comment of the user. */
  readonly returnTask: (id: string, comment: string | null) => void;
  /** Answers the question of a blocked task. The answer lands in its session, and the task runs on. */
  readonly answerTask: (id: string, answer: string) => void;
  /** Saves one record as a task template that keeps its brief, its checklist, its plan, and its category. */
  readonly saveTemplate: (id: string) => void;
  /** Removes one task template. The tasks that came from it stay as they are. */
  readonly removeTemplate: (id: string) => void;
  /** Puts one settled record away in the `archive/` folder. */
  readonly archive: (id: string) => void;
  /** Brings one archived record back to the live lists. */
  readonly restore: (id: string) => void;
}

/** The edit draft of one card: the text of its fields, the text of its cap fields, and the status
 * choice. Null keeps the stored status. */
export interface BoardDraft {
  title: string;
  description: string;
  goal: string;
  maxTokens: string;
  maxTurns: string;
  timeoutMin: string;
  /** True when the user typed in the time field. A save writes the limit then, and keeps the
   * stored one otherwise, because the field shows whole minutes. */
  timeoutTouched: boolean;
  priority: string;
  goals: string;
  category: string;
  status: TaskStatus | null;
}

/** The edit state of the board: which card sits in its edit form, the unsaved drafts and the typed
 * answers that survive a re-render so a settle elsewhere never eats a typed change, and the
 * category filter. An empty filter shows every category. */
export interface BoardEditState {
  readonly store: TaskStore;
  editingId: string | null;
  categoryFilter: string;
  readonly drafts: Map<string, BoardDraft>;
  /** The typed answer of each ask card, so a re-render keeps the text. */
  readonly answers: Map<string, string>;
  readonly requestRender: () => void;
}

/** The state groups of the board, in display order, with their dictionary keys. The review stands
 * alone, the live states follow, and every settled state closes the board. */
const GROUPS: readonly { readonly labelKey: 'groupReview' | 'groupLive' | 'groupSettled'; readonly states: readonly string[] }[] = [
  { labelKey: 'groupReview', states: ['review'] },
  { labelKey: 'groupLive', states: TASK_STATUSES.filter((status) => taskIsLive(status) && status !== 'review') },
  { labelKey: 'groupSettled', states: TASK_STATUSES.filter((status) => !taskIsLive(status)) },
];

/** Reads one cap field of the board: a whole number above zero, or null for an empty or invalid field. */
export function readCapInput(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** Reads one multi-line field of the board as a list: one item per line, and the empty lines drop out. */
export function readLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The categories of the live records and of the archived ones, in order, each once. */
export function boardCategories(store: TaskStore): string[] {
  const names = [...store.list(), ...store.archived()].map((task) => task.category).filter((name) => name.length > 0);
  return [...new Set(names)].sort();
}

/** Fills one select with the categories of the board: the first option shows every category. */
export function fillCategoryFilter(select: HTMLSelectElement, store: TaskStore, current: string): void {
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = translateMessage('tasks', 'categoryFilterAll');
  select.append(all);
  for (const name of boardCategories(store)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  // A filter that names a category the board lost reads as every category.
  select.value = boardCategories(store).includes(current) ? current : '';
}

/** Fills the template select of the create form: the first option names no template. */
export function fillTemplateSelect(select: HTMLSelectElement, store: TaskStore): void {
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = translateMessage('tasks', 'templateNone');
  select.append(none);
  for (const template of store.templates()) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.category ? `[${template.category}] ${template.title}` : template.title;
    select.append(option);
  }
  select.value = '';
}

/** The caps of one record in whole minutes, at least one, so a short limit never reads as zero. */
function minutesOf(timeoutMs: number): string {
  return String(Math.max(1, Math.round(timeoutMs / 60_000)));
}

/** Fills one priority select of the board forms with the levels from zero to the maximum, and
 * selects the level of one record. The queue starts the higher numbers first. */
export function fillPrioritySelect(select: HTMLSelectElement, priority: number): void {
  for (let level = 0; level <= TASK_PRIORITY_MAX; level += 1) {
    const option = document.createElement('option');
    option.value = String(level);
    option.textContent = translateMessage('tasks', 'priorityShort', { priority: String(level) });
    select.append(option);
  }
  select.value = String(priority);
}

/** The priority select of the edit form of one card. */
function prioritySelect(priority: number): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'task-priority-select';
  select.title = translateMessage('tasks', 'createPriorityTitle');
  fillPrioritySelect(select, priority);
  return select;
}

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

/** Builds one number field of the board forms. A cap reads as a whole number from its minimum. */
function numberInput(value: string, placeholder: string, min = 1): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.step = '1';
  input.value = value;
  input.placeholder = placeholder;
  return input;
}

/** The edit draft of one card: the one its form holds, or a fresh copy of the record. */
function draftOf(task: TaskRecord, edit: BoardEditState): BoardDraft {
  const existing = edit.drafts.get(task.id);
  if (existing) {
    return existing;
  }
  const draft: BoardDraft = {
    title: task.title,
    description: task.description,
    goal: task.goal,
    maxTokens: task.maxTokens ? String(task.maxTokens) : '',
    maxTurns: task.maxTurns ? String(task.maxTurns) : '',
    timeoutMin: task.timeoutMs ? minutesOf(task.timeoutMs) : '',
    timeoutTouched: false,
    priority: String(task.priority),
    goals: task.goals.map((goal) => goal.text).join('\n'),
    category: task.category,
    status: null,
  };
  edit.drafts.set(task.id, draft);
  return draft;
}

/** True for a record that retries: it failed, or a limit ended it. */
function retries(task: TaskRecord): boolean {
  return task.status === 'failed' || task.status === 'exhausted' || task.status === 'timeout';
}

/** The line of the note of one record, when it holds one. The note names why the record settled:
 * the reason of a failure, the blocker that ended it, or the comment of a cancel. Null without a
 * note. */
function noteLine(task: TaskRecord): HTMLElement | null {
  if (!task.note) {
    return null;
  }
  const note = document.createElement('p');
  note.className = 'task-board-note';
  note.textContent = translateMessage('tasks', 'notePrefix', { note: task.note });
  return note;
}

/** Appends the session picker of one draft or failed record to the given actions row and answers
 * its button, so the caller places the button after its neighbors. Null on any other record. A
 * draft dispatches onto a new chat that waits for it, or onto a picked session. A record that
 * retries uses the same picker: a new chat by default, and the chat of its ended run stays
 * selected while that chat is open. */
function buildDispatch(deps: TaskBoardDeps, task: TaskRecord, actions: HTMLElement): HTMLButtonElement | null {
  if (task.status !== 'draft' && !retries(task)) {
    return null;
  }
  const retry = retries(task);
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
  if (retry && task.sessionFileId && sessions.some((session) => session.fileId === task.sessionFileId)) {
    select.value = task.sessionFileId;
  }
  const run = async (): Promise<void> => {
    if (retry) {
      deps.retry(task.id, select.value ? 'session' : 'new-session', select.value || null);
      return;
    }
    if (!select.value) {
      // A new session opens as a chat that waits for the task. Its send dispatches the task with the picks of that tab.
      deps.openTaskChat(task.id);
      return;
    }
    deps.dispatch(task.id, 'session', select.value);
  };
  actions.append(label, select);
  return button(translateMessage('tasks', retry ? 'retry' : 'dispatch'), () => {
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
    draftOf(task, edit).status = select.value as TaskStatus;
  });
  return select;
}

/** Builds the edit form of one card: the title, the description, the goal, and the three caps over
 * the saved draft, with Save and Cancel. The inputs write the draft on every change, so a re-render
 * keeps the typed text. The status choice of the head select applies with the same Save. */
function buildEditForm(task: TaskRecord, edit: BoardEditState): HTMLElement {
  const form = document.createElement('form');
  form.className = 'task-board-edit';
  const draft = draftOf(task, edit);
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
  // The token budget takes the smallest cap a record takes: a smaller one sits at the wrap-up reserve from the first round.
  const maxTokens = numberInput(draft.maxTokens, translateMessage('tasks', 'editTokensPlaceholder'), TASK_MIN_TOKEN_CAP);
  const maxTurns = numberInput(draft.maxTurns, translateMessage('tasks', 'editTurnsPlaceholder'), TASK_MIN_TURN_CAP);
  const timeoutMin = numberInput(draft.timeoutMin, translateMessage('tasks', 'editTimeoutPlaceholder'));
  const priority = prioritySelect(Number(draft.priority));
  const goals = document.createElement('textarea');
  goals.value = draft.goals;
  goals.placeholder = translateMessage('tasks', 'editGoalsPlaceholder');
  const category = document.createElement('input');
  category.type = 'text';
  category.value = draft.category;
  category.placeholder = translateMessage('tasks', 'editCategoryPlaceholder');
  for (
    const [input, key] of [
      [title, 'title'],
      [description, 'description'],
      [goal, 'goal'],
      [maxTokens, 'maxTokens'],
      [maxTurns, 'maxTurns'],
      [timeoutMin, 'timeoutMin'],
      [priority, 'priority'],
      [goals, 'goals'],
      [category, 'category'],
    ] as const
  ) {
    input.addEventListener('input', () => {
      (draft as unknown as Record<string, string>)[key] = input.value;
    });
  }
  timeoutMin.addEventListener('input', () => {
    draft.timeoutTouched = true;
  });
  const save = button(translateMessage('tasks', 'save'), () => undefined, { primary: true });
  save.type = 'submit';
  // The submit runs the save for the click and the Enter key alike, and the prevented default
  // keeps the form from navigating the workspace page.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      // A cap follows its field: a number sets it, and an empty field clears it. The time field
      // shows whole minutes, so a field the user did not touch keeps the stored limit whole.
      const minutes = readCapInput(timeoutMin.value);
      await edit.store.update(task.id, {
        title: title.value.trim() || task.title,
        description: description.value.trim(),
        goal: goal.value.trim(),
        ...(draft.status && draft.status !== task.status ? { status: draft.status } : {}),
        maxTokens: readCapInput(maxTokens.value),
        maxTurns: readCapInput(maxTurns.value),
        ...(draft.timeoutTouched ? { timeoutMs: minutes ? minutes * 60_000 : null } : {}),
        priority: Number(priority.value),
        goals: readLines(goals.value),
        category: category.value.trim(),
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
  form.append(title, description, goal, goals, category, maxTokens, maxTurns, timeoutMin, priority, controls);
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
  // The category of the record names its group beside the title.
  if (task.category) {
    const category = document.createElement('span');
    category.className = 'task-board-category';
    category.textContent = task.category;
    head.append(category);
  }
  if (edit.editingId === task.id) {
    head.append(buildStatusChoice(task, edit));
  } else {
    const status = document.createElement('span');
    status.className = 'task-board-status';
    status.textContent = task.status;
    head.append(status);
  }
  // A priority off the default shows beside the status: the queue starts the higher numbers first.
  if (task.priority !== TASK_PRIORITY_DEFAULT) {
    const priority = document.createElement('span');
    priority.className = 'task-board-priority';
    priority.textContent = translateMessage('tasks', 'priorityShort', { priority: String(task.priority) });
    head.append(priority);
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
  // The checklist: a met goal carries the evidence that met it, and an open one waits for its proof.
  if (task.goals.length > 0) {
    const goals = document.createElement('ol');
    goals.className = 'task-board-goals';
    for (const entry of task.goals) {
      const item = document.createElement('li');
      item.className = entry.met ? 'met' : 'open';
      const proof = entry.evidence.map(taskEvidenceLabel).join(', ');
      item.textContent = entry.met && proof ? `${entry.text} (${proof})` : entry.text;
      goals.append(item);
    }
    card.append(goals);
  }
  // The plan the session agent wrote: one marked step per line.
  if (task.plan.length > 0) {
    const plan = document.createElement('ol');
    plan.className = 'task-board-plan';
    for (const step of task.plan) {
      const item = document.createElement('li');
      item.className = step.state;
      item.textContent = step.text;
      plan.append(item);
    }
    card.append(plan);
  }
  if (task.result) {
    const result = document.createElement('p');
    result.className = 'task-board-result';
    result.textContent = translateMessage('tasks', 'resultPrefix', { result: task.result });
    card.append(result);
  }
  // The caps show when the record carries one, the spend once a session ran a round, and the cause once a limit ended it.
  if (task.maxTokens || task.maxTurns || task.timeoutMs) {
    const caps = document.createElement('p');
    caps.className = 'task-board-caps';
    caps.textContent = translateMessage('tasks', 'capsLine', {
      tokens: task.maxTokens ? String(task.maxTokens) : '–',
      turns: task.maxTurns ? String(task.maxTurns) : '–',
      minutes: task.timeoutMs ? minutesOf(task.timeoutMs) : '–',
    });
    card.append(caps);
  }
  if (task.turns > 0) {
    const spend = document.createElement('p');
    spend.className = 'task-board-spend';
    spend.textContent = translateMessage('tasks', task.turns === 1 ? 'spendLineOne' : 'spendLine', {
      tokens: String(task.tokensIn + task.tokensOut),
      input: String(task.tokensIn),
      output: String(task.tokensOut),
      turns: String(task.turns),
    });
    card.append(spend);
  }
  if (task.endCause) {
    const cause = document.createElement('p');
    cause.className = 'task-board-cause';
    cause.textContent = translateMessage('tasks', 'causePrefix', { cause: task.endCause });
    card.append(cause);
  }
  const note = noteLine(task);
  if (note) {
    card.append(note);
  }
  const actions = document.createElement('div');
  actions.className = 'task-board-row';
  actions.append(
    button(translateMessage('tasks', 'edit'), () => {
      edit.editingId = task.id;
      edit.requestRender();
    }),
    button(translateMessage('tasks', 'saveTemplate'), () => {
      deps.saveTemplate(task.id);
    }),
  );
  // A blocked task shows the question of its session, and the field that answers it.
  if (task.status === 'blocked' && task.question) {
    // The typed answer survives a re-render, and it leaves with the answer.
    card.append(
      buildTaskAskCard(
        task.question,
        (text) => {
          edit.answers.delete(task.id);
          deps.answerTask(task.id, text);
        },
        {
          text: edit.answers.get(task.id) ?? '',
          keep: (text) => {
            edit.answers.set(task.id, text);
          },
        },
      ),
    );
  }
  if (task.status === 'draft' || task.status === 'queued' || task.status === 'running' || task.status === 'blocked') {
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
  // A record that failed, or ended by a limit, retries on the session its picker names, beside the controls of a settled record.
  if (retries(task)) {
    const retry = buildDispatch(deps, task, actions);
    if (retry) {
      actions.append(retry);
    }
  }
  if (!taskIsLive(task.status)) {
    // A settled record goes to the archive folder, or leaves for good.
    actions.append(
      button(translateMessage('tasks', 'archive'), () => {
        deps.archive(task.id);
      }),
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
  const shown = (task: TaskRecord): boolean => !edit.categoryFilter || task.category === edit.categoryFilter;
  for (const group of GROUPS) {
    const members = records.filter((task) => group.states.includes(task.status) && shown(task));
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
  // The archived records close the board: the user put them away, and a restore brings one back.
  const archived = deps.store.archived().filter(shown);
  if (archived.length > 0) {
    const section = document.createElement('section');
    section.className = 'task-board-group';
    const head = document.createElement('h2');
    head.textContent = translateMessage('tasks', 'groupHeading', {
      label: translateMessage('tasks', 'groupArchived'),
      count: String(archived.length),
    });
    section.append(head);
    for (const task of archived) {
      section.append(buildArchivedCard(deps, task));
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

/** Builds the card of one archived record: its state, its title, its result, and the controls that
 * bring it back or remove it for good. */
function buildArchivedCard(deps: TaskBoardDeps, task: TaskRecord): HTMLElement {
  const card = document.createElement('article');
  card.className = `task-board-card ${task.status}`;
  const head = document.createElement('div');
  head.className = 'task-board-card-head';
  const status = document.createElement('span');
  status.className = 'task-board-status';
  status.textContent = task.status;
  const title = document.createElement('h3');
  title.textContent = task.title;
  head.append(status, title);
  card.append(head);
  if (task.result) {
    const result = document.createElement('p');
    result.className = 'task-board-result';
    result.textContent = translateMessage('tasks', 'resultPrefix', { result: task.result });
    card.append(result);
  }
  const note = noteLine(task);
  if (note) {
    card.append(note);
  }
  const actions = document.createElement('div');
  actions.className = 'task-board-row';
  actions.append(
    button(translateMessage('tasks', 'restore'), () => {
      deps.restore(task.id);
    }, { primary: true, push: true }),
    button(translateMessage('tasks', 'remove'), () => {
      void deps.store.remove(task.id);
    }, { danger: true }),
  );
  card.append(actions);
  return card;
}
