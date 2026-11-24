/**
 * The phone page of the remote control. It pairs with the token from the URL fragment or a
 * manual entry, keeps the bearer in the local storage, renders the permission asks, the patch
 * proposals, the task reviews, and the chat sessions, and answers through the API of the worker
 * core. The event stream rides a fetch stream with the authorization header, so no credential
 * lands in a URL. The replies and the patch diffs render through the shared text stack of the app,
 * and the chats render their cards through the shared chat card stack of the app, so the phone
 * shows the reasoning and the tool calls like the workspace chat.
 * The tabs sit under the top bar, and both leave while a tab scrolls down.
 * A chat that sent nothing carries a setup card: the provider, the model, and the system prompt
 * source of its first message, and the card of the task it waits for. The tasks tab opens such a
 * chat for a draft task.
 */

import { JsonViewerElement } from '../json-viewer-element.js';
import {
  appendAnswer,
  appendReasoning,
  appendToolCalls,
  buildImageStrip,
  buildToolPair,
  buildToolReplyCard,
  type EntrySlot,
  groupChatEntries,
  type MessageGroup,
  replyBubbleClass,
  type ToolPairChips,
} from '../chat-cards/render.js';
import type { CoreChatEntry } from '../../shared/core-api.js';
import { buildDiff, renderMarkdown } from '../text/render.js';

interface PendingAsk {
  readonly id: number;
  readonly principal: string;
  readonly action: string;
  readonly target: string;
  readonly command: string | null;
  readonly detail: string;
  readonly createdAt: number;
  readonly source: string | null;
}

interface PatchItem {
  readonly id: number;
  readonly path: string;
  readonly patch: string;
  readonly state: string;
  readonly comment: string | null;
  readonly createdAt: string;
}

interface TaskItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly description?: string;
  readonly goal?: string;
  readonly result: string | null;
}

interface ChatSessionDto {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  /** The entries of the chat in the shape the engine stores them: a reply carries its reasoning
   * and its tool calls, and a tool result carries the call it answers. */
  readonly entries: readonly CoreChatEntry[];
  /** The system prompt the chat bound on its first message, when it sent one. */
  readonly systemPrompt?: { sourceId: string; title: string; text: string };
  /** The draft task the chat waits for. Its first send dispatches the task into the chat. */
  readonly waitingTaskId?: string;
  /** The provider account and the model the chat bound on its first message, when it sent one. */
  readonly boundProviderId?: string;
  readonly boundModel?: string;
}

/** One system prompt source of the menu, as the server lists it. */
interface PromptSourceDto {
  readonly id: string;
  readonly label: string;
}

/** One provider account of the connection menu, as the server lists it. No key rides along. */
interface ConnectionAccountDto {
  readonly id: string;
  readonly label: string;
  readonly models: { id: string; label: string }[];
}

/** The connection menu of the workspace: the accounts a first message picks from, and the defaults. */
interface ConnectionMenuDto {
  readonly accounts: readonly ConnectionAccountDto[];
  readonly defaultProviderId: string | null;
  readonly defaultModel: string | null;
}

/** One state snapshot of the server: the answer of `/api/state` and the first frame of the stream. */
interface StateSnapshot {
  readonly permission?: unknown;
  readonly patches?: unknown;
  readonly tasks?: unknown;
  readonly name?: unknown;
  readonly prompts?: unknown;
}

const STORAGE_KEY = 'nodewavenui-remote-token';

/** The option value of the session drop-down that opens a fresh session. No session id reads so. */
const NEW_SESSION = 'new';

/** The connection menu while the server listed none, or answered another shape. */
const EMPTY_CONNECTION_MENU: ConnectionMenuDto = { accounts: [], defaultProviderId: null, defaultModel: null };

/** The system prompt sources of the menu, in menu order. The state snapshot carries them. */
let promptSources: readonly PromptSourceDto[] = [];

/** The connection menu of the workspace. The chats tab reads it with the session list. */
let connectionMenu: ConnectionMenuDto = EMPTY_CONNECTION_MENU;

/** The source the menu of one chat holds before its first message, keyed by session id. */
const heldPromptPicks = new Map<string, string>();

/** The provider and the model the setup of one chat holds before its first message, keyed by session id. */
const heldConnectionPicks = new Map<string, { providerId: string; model: string }>();

const workspaceName = document.querySelector<HTMLElement>('#workspace-name');
const connectionBadge = document.querySelector<HTMLElement>('#connection');
const loginView = document.querySelector<HTMLElement>('#login');
const remoteView = document.querySelector<HTMLElement>('#remote');
const loginForm = document.querySelector<HTMLFormElement>('#login-form');
const loginToken = document.querySelector<HTMLInputElement>('#login-token');
const loginPassword = document.querySelector<HTMLInputElement>('#login-password');
const loginStatus = document.querySelector<HTMLElement>('#login-status');

let bearer = '';
let streamAbort: AbortController | null = null;
let activeChat: ChatSessionDto | null = null;
/** The entry indexes of the reasoning disclosures the user opened in the active chat, so they stay
 * open across the re-renders of the chat. */
const openReasoning = new Set<string>();
/** True while the bound prompt of the active chat stands open, so it stays open across its re-renders. */
let promptOpen = false;
/** The id of the chat the open disclosures belong to. Another chat renders with every one closed. */
let disclosedChatId: string | null = null;
const state = {
  permission: { pending: [] as PendingAsk[], rules: [] as unknown[] },
  patches: { patches: [] as PatchItem[], tasks: [] as { id: number; title: string; closedAt: string | null }[] },
  tasks: { records: [] as TaskItem[] },
};

/** Runs one API call with the bearer. Throws with the answer text on a failure. */
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

/** Applies one state snapshot to the views. */
function applyState(next: StateSnapshot): void {
  if (next.permission && typeof next.permission === 'object') {
    state.permission = next.permission as typeof state.permission;
  }
  if (next.patches && typeof next.patches === 'object') {
    state.patches = next.patches as typeof state.patches;
  }
  if (next.tasks && typeof next.tasks === 'object') {
    state.tasks = next.tasks as typeof state.tasks;
  }
  // An empty name keeps the app name of the page.
  if (typeof next.name === 'string' && next.name && workspaceName) {
    workspaceName.textContent = next.name;
  }
  if (Array.isArray(next.prompts)) {
    promptSources = next.prompts as readonly PromptSourceDto[];
  }
  renderApprovals();
  renderPatches();
  renderTasks();
}

/** The milliseconds one reconnect waits, the retry hint the server sends. */
const RECONNECT_MILLISECONDS = 3000;

/** Opens the event stream over a fetch connection and dispatches every event. A dropped
 * connection reconnects until a new call aborts it, so the page heals on its own. */
function openStream(): void {
  streamAbort?.abort();
  streamAbort = new AbortController();
  const controller = streamAbort;
  void (async () => {
    while (!controller.signal.aborted) {
      let ended: 'ended' | 'refused';
      try {
        ended = await runStreamOnce(controller.signal);
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        ended = 'ended';
      }
      if (controller.signal.aborted) {
        return;
      }
      if (ended === 'refused') {
        setConnection('offline');
        showLogin('The event stream refused the connection.');
        return;
      }
      setConnection('offline');
      await new Promise((resolve) => {
        setTimeout(resolve, RECONNECT_MILLISECONDS);
      });
    }
  })();
}

/** Reads one event stream connection until it ends. Answers how it ended. */
async function runStreamOnce(signal: AbortSignal): Promise<'ended' | 'refused'> {
  const response = await fetch('/api/events', { headers: { authorization: `Bearer ${bearer}` }, signal });
  if (!response.ok || !response.body) {
    return 'refused';
  }
  setConnection('online');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return 'ended';
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      dispatchFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/** Dispatches one server-sent event frame. */
function dispatchFrame(frame: string): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice('data: '.length));
    }
  }
  if (dataLines.length === 0) {
    return;
  }
  const payload: unknown = JSON.parse(dataLines.join('\n'));
  if (event === 'state') {
    applyState(payload as StateSnapshot);
    return;
  }
  if (event === 'permission') {
    if (payload && typeof payload === 'object') {
      state.permission = payload as typeof state.permission;
      renderApprovals();
    }
    return;
  }
  if (event === 'patches') {
    if (payload && typeof payload === 'object') {
      state.patches = payload as typeof state.patches;
      renderPatches();
    }
    return;
  }
  if (event === 'tasks') {
    if (payload && typeof payload === 'object') {
      state.tasks = payload as typeof state.tasks;
      renderTasks();
    }
  }
}

/** Sets the connection badge. */
function setConnection(text: string): void {
  if (connectionBadge) {
    connectionBadge.textContent = text;
    connectionBadge.classList.toggle('online', text === 'online');
  }
}

/** Shows the login view with one status line. */
function showLogin(message?: string): void {
  if (loginView) {
    loginView.hidden = false;
  }
  if (remoteView) {
    remoteView.hidden = true;
  }
  if (loginStatus && message) {
    loginStatus.textContent = message;
  }
}

/** Enters the remote view and opens the stream. */
async function enterRemote(): Promise<void> {
  if (loginView) {
    loginView.hidden = true;
  }
  if (remoteView) {
    remoteView.hidden = false;
  }
  try {
    applyState((await api('/api/state')) as StateSnapshot);
  } catch (error) {
    showLogin(error instanceof Error ? error.message : String(error));
    return;
  }
  openStream();
}

/** Renders the approvals view. */
function renderApprovals(): void {
  const view = document.querySelector<HTMLElement>('#view-approvals');
  if (!view) {
    return;
  }
  view.replaceChildren();
  const asks = [...state.permission.pending].sort((left, right) => left.createdAt - right.createdAt);
  if (asks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'status';
    empty.textContent = 'No permission ask waits.';
    view.append(empty);
    return;
  }
  for (const ask of asks) {
    const card = document.createElement('div');
    card.className = 'card';
    const text = document.createElement('p');
    text.textContent = ask.command ?? `${ask.principal} asks to ${ask.action} ${ask.target}`;
    card.append(text);
    if (ask.command) {
      const pre = document.createElement('pre');
      pre.textContent = ask.command;
      card.append(pre);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => {
      void api('/api/permission/resolve', { method: 'POST', body: JSON.stringify({ id: ask.id, approve: true, remember: false }) }).catch(showError);
    });
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => {
      void api('/api/permission/resolve', { method: 'POST', body: JSON.stringify({ id: ask.id, approve: false, remember: false }) }).catch(showError);
    });
    row.append(approve, deny);
    card.append(row);
    view.append(card);
  }
}

/** Renders the patches view. */
function renderPatches(): void {
  const view = document.querySelector<HTMLElement>('#view-patches');
  if (!view) {
    return;
  }
  view.replaceChildren();
  const waiting = state.patches.patches.filter((patch) => patch.state === 'pending' || patch.state === 'conflicted');
  if (waiting.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'status';
    empty.textContent = 'No patch waits for review.';
    view.append(empty);
    return;
  }
  for (const patch of waiting) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('p');
    title.textContent = patch.path;
    card.append(title);
    if (patch.comment) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = patch.comment;
      card.append(note);
    }
    card.append(buildDiff(patch.patch, patch.path));
    const row = document.createElement('div');
    row.className = 'row';
    const apply = document.createElement('button');
    apply.className = 'approve';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => {
      void api('/api/patch/apply', { method: 'POST', body: JSON.stringify({ id: patch.id }) }).catch(showError);
    });
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => {
      const comment = window.prompt('Comment for the agent (optional)');
      void api('/api/patch/deny', { method: 'POST', body: JSON.stringify({ id: patch.id, comment }) }).catch(showError);
    });
    row.append(apply, deny);
    card.append(row);
    view.append(card);
  }
}

/** Builds the body of one task card: the status and the title, the brief, and the goal. */
function taskCardBody(task: TaskItem): HTMLElement {
  const body = document.createElement('div');
  body.className = 'task-card-body';
  const head = document.createElement('div');
  head.className = 'task-card-head';
  const badge = document.createElement('span');
  badge.className = 'task-card-badge';
  badge.textContent = task.status;
  const title = document.createElement('span');
  title.className = 'task-card-title';
  title.textContent = task.title;
  head.append(badge, title);
  body.append(head);
  if (task.description) {
    const description = document.createElement('div');
    description.className = 'md-body task-card-description';
    renderMarkdown(description, task.description);
    body.append(description);
  }
  if (task.goal) {
    const goal = document.createElement('p');
    goal.className = 'task-card-goal';
    goal.textContent = `Goal: ${task.goal}`;
    body.append(goal);
  }
  return body;
}

/** Renders the tasks view: the draft tasks with their new-session action, then the reviews. */
function renderTasks(): void {
  const view = document.querySelector<HTMLElement>('#view-tasks');
  if (!view) {
    return;
  }
  view.replaceChildren();
  const drafts = state.tasks.records.filter((task) => task.status === 'draft');
  const reviews = state.tasks.records.filter((task) => task.status === 'review');
  if (drafts.length === 0 && reviews.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'status';
    empty.textContent = 'No draft task and no review wait.';
    view.append(empty);
    return;
  }
  for (const task of drafts) {
    const card = document.createElement('div');
    card.className = 'card task-card';
    card.append(taskCardBody(task));
    const row = document.createElement('div');
    row.className = 'row';
    const start = document.createElement('button');
    start.className = 'primary';
    start.textContent = 'New session';
    start.addEventListener('click', () => {
      openTaskChat(task.id);
    });
    row.append(start);
    card.append(row);
    view.append(card);
  }
  for (const task of reviews) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('p');
    title.textContent = task.title;
    card.append(title);
    if (task.result) {
      const pre = document.createElement('pre');
      pre.textContent = task.result;
      card.append(pre);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const accept = document.createElement('button');
    accept.className = 'approve';
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => {
      void api('/api/task/accept', { method: 'POST', body: JSON.stringify({ id: task.id }) }).catch(showError);
    });
    const back = document.createElement('button');
    back.textContent = 'Return';
    back.addEventListener('click', () => {
      void api('/api/task/return', { method: 'POST', body: JSON.stringify({ id: task.id }) }).catch(showError);
    });
    row.append(accept, back);
    card.append(row);
    view.append(card);
  }
}

/** Renders the chats view: the session list while no chat opens, then one drop-down above the
   chat, so the chat keeps the room. The list holds every chat of the engine, so a session that
   left the engine closes here too. */
function renderChats(sessions: readonly ChatSessionDto[]): void {
  activeChat = sessions.find((session) => session.id === activeChat?.id) ?? null;
  const view = document.querySelector<HTMLElement>('#view-chats');
  if (!view) {
    return;
  }
  view.replaceChildren();
  if (!activeChat) {
    const list = document.createElement('div');
    list.className = 'card chat-session-list';
    const fresh = document.createElement('button');
    fresh.className = 'chat-session primary';
    fresh.textContent = 'New Session';
    fresh.addEventListener('click', () => {
      createChat(sessions);
    });
    list.append(fresh);
    for (const session of sessions) {
      const button = document.createElement('button');
      button.className = 'chat-session';
      button.textContent = session.title;
      button.addEventListener('click', () => {
        openChat(sessions, session.id);
      });
      list.append(button);
    }
    view.append(list);
    return;
  }
  const picker = document.createElement('select');
  picker.className = 'chat-session-select';
  picker.setAttribute('aria-label', 'Chat session');
  const fresh = document.createElement('option');
  fresh.value = NEW_SESSION;
  fresh.textContent = 'New Session';
  picker.append(fresh);
  for (const session of sessions) {
    const option = document.createElement('option');
    option.value = session.id;
    option.textContent = session.title;
    picker.append(option);
  }
  picker.value = activeChat.id;
  picker.addEventListener('change', () => {
    if (picker.value === NEW_SESSION) {
      createChat(sessions);
      return;
    }
    openChat(sessions, picker.value);
  });
  // The drop-down and the button that closes the active session share one row.
  const row = document.createElement('div');
  row.className = 'chat-session-row';
  row.append(picker, buildCloseButton(sessions));
  view.append(row);
  renderChat(activeChat);
}

/** Builds the button that closes the active session, at the right of the session drop-down. The
   core closes the chat the way the close of a tab does: its session file drops, a task that runs in
   it settles cancelled, and its running turn stops. The page asks first, because a tap here lands
   beside the drop-down, and the messages do not come back. The session list shows again after. */
function buildCloseButton(sessions: readonly ChatSessionDto[]): HTMLButtonElement {
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'chat-session-close';
  close.title = 'Close this session. Its messages are deleted, and a task that runs in it is cancelled.';
  close.textContent = 'Close';
  close.addEventListener('click', () => {
    if (!activeChat || !window.confirm(`Close the session "${activeChat.title}"? Its messages are deleted.`)) {
      return;
    }
    const closed = activeChat;
    void api('/api/chat/close', { method: 'POST', body: JSON.stringify({ fileId: closed.id }) })
      .then(refreshChats)
      .catch((error: unknown) => {
        showError(error);
        activeChat = closed;
        renderChats(sessions);
      });
  });
  return close;
}

/** Opens one session of a list as the active chat. */
function openChat(sessions: readonly ChatSessionDto[], id: string): void {
  const session = sessions.find((candidate) => candidate.id === id);
  if (!session) {
    return;
  }
  activeChat = session;
  renderChats(sessions);
}

/** Reads the connection menu out of one server answer. Another shape reads as an empty menu. */
function readConnectionMenu(value: unknown): ConnectionMenuDto {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { accounts?: unknown }).accounts)) {
    return EMPTY_CONNECTION_MENU;
  }
  return value as ConnectionMenuDto;
}

/** Reads the session list and the connection menu, then draws the chats view. */
function refreshChats(): Promise<void> {
  return Promise.all([api('/api/chat/sessions'), api('/api/chat/connections')]).then(([sessions, connections]) => {
    connectionMenu = readConnectionMenu(connections);
    renderChats(sessions as readonly ChatSessionDto[]);
  });
}

/** Opens one fresh session in the engine as the active chat. The session list reads again after,
 * so the drop-down holds the fresh session. A task id names the draft task the chat waits for. */
function createChat(sessions: readonly ChatSessionDto[], taskId?: string): void {
  api('/api/chat/create', { method: 'POST', body: JSON.stringify(taskId ? { taskId } : {}) })
    .then((session) => {
      activeChat = session as ChatSessionDto;
      return refreshChats();
    })
    .catch((error: unknown) => {
      showError(error);
      renderChats(sessions);
    });
}

/** Opens a new chat that waits for one draft task, and shows it in the chats tab. The send of that
 * chat dispatches the task. */
function openTaskChat(taskId: string): void {
  api('/api/chat/create', { method: 'POST', body: JSON.stringify({ taskId }) })
    .then((session) => {
      activeChat = session as ChatSessionDto;
      showTab('chats');
    })
    .catch(showError);
}

/** The live selects of the setup card of one chat, so a send reads the picks they hold. A select
   stays null while the page offers no choice for it. */
interface SetupControls {
  readonly provider: HTMLSelectElement | null;
  readonly model: HTMLSelectElement | null;
  readonly prompt: HTMLSelectElement | null;
}

/** The selects that are off, for a chat past its setup. */
const NO_SETUP: SetupControls = { provider: null, model: null, prompt: null };

/** The account the provider select starts on: the held account, the default of the workspace, or
   the first one. */
function preferredAccount(held: string | undefined): ConnectionAccountDto | undefined {
  const accounts = connectionMenu.accounts;
  return (
    accounts.find((account) => account.id === held) ??
    accounts.find((account) => account.id === connectionMenu.defaultProviderId) ??
    accounts[0]
  );
}

/** Fills the model select with the models of one account, and starts it on the held model, the
   default of the workspace, or the first one. */
function fillModels(select: HTMLSelectElement, accountId: string, held: string | undefined): void {
  const models = connectionMenu.accounts.find((account) => account.id === accountId)?.models ?? [];
  select.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    select.append(option);
  }
  const wanted = [held, connectionMenu.defaultModel ?? undefined, models[0]?.id].find((id) =>
    models.some((model) => model.id === id),
  );
  select.value = wanted ?? '';
}

/** Builds one labeled select row of the setup card. The label wraps the select, so a tap on the
   label reaches the select. */
function setupRow(labelText: string, select: HTMLSelectElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'chat-setup-row';
  const label = document.createElement('span');
  label.className = 'chat-setup-label';
  label.textContent = labelText;
  row.append(label, select);
  return row;
}

/** Places the setup card of one chat that sent nothing, first in its message area: the provider,
   the model, and the system prompt source of its first message. The card keeps only the rows the
   page can offer. Answers the live selects. */
function appendSetupCard(scroll: HTMLElement, session: ChatSessionDto): SetupControls {
  const card = document.createElement('div');
  card.className = 'chat-setup';
  const held = heldConnectionPicks.get(session.id);
  let provider: HTMLSelectElement | null = null;
  let model: HTMLSelectElement | null = null;
  if (connectionMenu.accounts.length === 0) {
    const none = document.createElement('p');
    none.className = 'chat-setup-empty';
    none.textContent = 'No provider is configured.';
    card.append(none);
  } else {
    const providerSelect = document.createElement('select');
    providerSelect.className = 'chat-setup-select';
    providerSelect.title = 'The provider of the first message. The chat stays on it after the send.';
    for (const account of connectionMenu.accounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.label;
      providerSelect.append(option);
    }
    const modelSelect = document.createElement('select');
    modelSelect.className = 'chat-setup-select';
    modelSelect.title = 'The model of the first message. The chat stays on it after the send.';
    providerSelect.value = preferredAccount(held?.providerId)?.id ?? '';
    fillModels(modelSelect, providerSelect.value, held?.model);
    providerSelect.addEventListener('change', () => {
      // A new provider starts on its own default model, like the app.
      fillModels(modelSelect, providerSelect.value, undefined);
      heldConnectionPicks.set(session.id, { providerId: providerSelect.value, model: modelSelect.value });
    });
    modelSelect.addEventListener('change', () => {
      heldConnectionPicks.set(session.id, { providerId: providerSelect.value, model: modelSelect.value });
    });
    card.append(
      setupRow('Provider', providerSelect),
      setupRow('Model', modelSelect),
    );
    provider = providerSelect;
    model = modelSelect;
  }
  let prompt: HTMLSelectElement | null = null;
  if (promptSources.length > 0) {
    const promptSelect = document.createElement('select');
    promptSelect.className = 'chat-setup-select';
    promptSelect.title = 'The system prompt of the first message. The chat keeps it after the send.';
    for (const source of promptSources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label;
      promptSelect.append(option);
    }
    const heldPrompt = heldPromptPicks.get(session.id);
    promptSelect.value =
      heldPrompt && promptSources.some((source) => source.id === heldPrompt) ? heldPrompt : (promptSources[0]?.id ?? '');
    promptSelect.addEventListener('change', () => {
      heldPromptPicks.set(session.id, promptSelect.value);
    });
    card.append(setupRow('System prompt', promptSelect));
    prompt = promptSelect;
  }
  scroll.append(card);
  return { provider, model, prompt };
}

/** Places the line of the connection one chat bound on its first message, first in its message
 * area: the provider and the model, as one quiet line like the locked labels of the app. Nothing
 * renders while the chat bound no provider. */
function appendBoundConnection(scroll: HTMLElement, session: ChatSessionDto): void {
  if (!session.boundProviderId) {
    return;
  }
  const account = connectionMenu.accounts.find((candidate) => candidate.id === session.boundProviderId);
  const model = account?.models.find((candidate) => candidate.id === session.boundModel);
  const line = document.createElement('div');
  line.className = 'entry notice chat-bound-connection';
  line.textContent = `${account?.label ?? 'unknown provider'} · ${model?.label ?? session.boundModel ?? '–'}`;
  scroll.append(line);
}

/** Places the system prompt one chat bound on its first message: a collapsed bubble on the
 * assistant side, open again when the user left it open. A bound prompt without text, the none
 * source, renders nothing. */
function appendBoundPrompt(scroll: HTMLElement, session: ChatSessionDto): void {
  const bound = session.systemPrompt;
  if (!bound || bound.text.length === 0) {
    return;
  }
  const item = document.createElement('div');
  item.className = 'entry assistant system-prompt-item';
  const disclosure = document.createElement('details');
  disclosure.className = 'system-prompt';
  disclosure.open = promptOpen;
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  label.className = 'system-prompt-title';
  label.textContent = bound.title;
  const body = document.createElement('div');
  // The prompt text renders as markdown with highlighted code, like a reply.
  body.className = 'system-prompt-body md-body';
  renderMarkdown(body, bound.text);
  summary.append(label);
  disclosure.append(summary, body);
  item.append(disclosure);
  scroll.append(item);
}

/** Places the setup of one chat first in its message area. A chat that sent nothing and bound
 * nothing gets its setup card. A chat past that point gets the line of the connection it bound,
 * then its collapsed bound prompt. Answers the live selects while the card shows. */
function appendChatSetup(scroll: HTMLElement, session: ChatSessionDto): SetupControls {
  const sent = session.entries.some((entry) => entry.role === 'user' || entry.role === 'assistant');
  if (!sent && !session.systemPrompt && !session.boundProviderId) {
    return appendSetupCard(scroll, session);
  }
  appendBoundConnection(scroll, session);
  appendBoundPrompt(scroll, session);
  return NO_SETUP;
}

/** The draft task one chat waits for, or null: the chat waits for none, or the task left the draft state. */
function waitingTask(session: ChatSessionDto): TaskItem | null {
  if (!session.waitingTaskId) {
    return null;
  }
  const task = state.tasks.records.find((record) => record.id === session.waitingTaskId);
  return task && task.status === 'draft' ? task : null;
}

/** Places the card of the task one chat waits for, under its setup card. The send of the chat
   dispatches the task with the picks of that card. */
function appendTaskCard(scroll: HTMLElement, task: TaskItem): void {
  const card = document.createElement('div');
  card.className = 'chat-task-card';
  card.append(taskCardBody(task));
  const hint = document.createElement('p');
  hint.className = 'task-card-hint';
  hint.textContent = 'Send starts this task with the settings above. A message is optional.';
  card.append(hint);
  scroll.append(card);
}

/** Places one entry of one chat: the bubble of a request, a reply, or a quiet line, or the card of
 * a tool reply that lost its call. A reply carries its reasoning disclosure and its answer like the
 * app. A persisted empty reply renders nothing. */
function appendEntry(scroll: HTMLElement, slot: EntrySlot): void {
  const { index, entry } = slot;
  if (entry.role === 'tool' || (entry.toolName && entry.role !== 'user')) {
    scroll.append(buildToolReplyCard(entry));
    return;
  }
  if (entry.role === 'assistant') {
    if (!entry.content && !entry.reasoning) {
      return;
    }
    const reply = document.createElement('div');
    reply.dataset.entryIndex = String(index);
    reply.className = replyBubbleClass('entry assistant', entry);
    appendReasoning(reply, entry, openReasoning.has(String(index)));
    if (entry.content) {
      appendAnswer(reply, entry);
    }
    scroll.append(reply);
    return;
  }
  const line = document.createElement('div');
  line.className = `entry ${entry.role}`;
  line.textContent = entry.content;
  if (entry.images && entry.images.length > 0) {
    line.append(buildImageStrip(entry.images));
  }
  scroll.append(line);
}

/** Places one agent turn like the app: the intro bubble of the reply with its reasoning
 * disclosure, then one pair card per tool call and every result that lost its call. */
function appendAgentTurn(scroll: HTMLElement, group: Extract<MessageGroup, { kind: 'agent' }>): void {
  const { index, entry } = group.request;
  if (entry.reasoning || entry.content) {
    const intro = document.createElement('div');
    intro.dataset.entryIndex = String(index);
    intro.className = replyBubbleClass('entry assistant', entry);
    appendReasoning(intro, entry, openReasoning.has(String(index)));
    if (entry.content) {
      appendAnswer(intro, entry);
    }
    scroll.append(intro);
  }
  appendToolCalls(scroll, entry, group.replies.map((slot) => slot.entry), 'div');
}

/** Places the entries of one chat, grouped like the message list of the app: one entry, an MCP
 * request with its reply in one pair card, or one agent turn. The chat shows its last forty
 * entries, so a group that starts before them stays out. */
function appendEntries(scroll: HTMLElement, session: ChatSessionDto): void {
  const first = Math.max(0, session.entries.length - 40);
  for (const group of groupChatEntries(session.entries)) {
    const index = group.kind === 'single' ? group.slot.index : group.request.index;
    if (index < first) {
      continue;
    }
    if (group.kind === 'single') {
      appendEntry(scroll, group.slot);
    } else if (group.kind === 'agent') {
      appendAgentTurn(scroll, group);
    } else {
      const request = group.request.entry;
      const chips: ToolPairChips = { ...(request.mcpSession ? { session: request.mcpSession } : {}) };
      scroll.append(
        buildToolPair('div', request.toolName ?? request.content, request.json, group.reply?.entry ?? null, chips),
      );
    }
  }
}

/** Renders the active chat with its send box, under the session drop-down of the view. */
function renderChat(session: ChatSessionDto): void {
  const view = document.querySelector<HTMLElement>('#view-chats');
  if (!view) {
    return;
  }
  // The open disclosures belong to one chat: another chat renders with every one closed.
  if (session.id !== disclosedChatId) {
    openReasoning.clear();
    promptOpen = false;
    disclosedChatId = session.id;
  }
  const card = document.createElement('div');
  card.className = 'chat-view';
  const scroll = document.createElement('div');
  scroll.className = 'chat-scroll';
  // The toggle event of a disclosure does not bubble, so the capture phase of the area catches it.
  scroll.addEventListener(
    'toggle',
    (event) => {
      const disclosure = event.target;
      if (!(disclosure instanceof HTMLDetailsElement)) {
        return;
      }
      if (disclosure.classList.contains('system-prompt')) {
        promptOpen = disclosure.open;
        return;
      }
      const key = disclosure.closest<HTMLElement>('[data-entry-index]')?.dataset.entryIndex;
      if (!key) {
        return;
      }
      if (disclosure.open) {
        openReasoning.add(key);
      } else {
        openReasoning.delete(key);
      }
    },
    true,
  );
  const setup = appendChatSetup(scroll, session);
  const task = waitingTask(session);
  if (task) {
    appendTaskCard(scroll, task);
  }
  appendEntries(scroll, session);
  card.append(scroll);
  const form = document.createElement('form');
  form.id = 'chat-send';
  const input = document.createElement('input');
  input.type = 'text';
  // A chat that waits for a task sends without a message: the brief of the task is the message.
  input.placeholder = task ? 'Message (optional)' : 'Message';
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  form.append(input, send);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text.length === 0 && !task) {
      return;
    }
    input.value = '';
    // The first message of the chat carries the picks its setup card holds.
    const picks = {
      ...(setup.provider ? { providerId: setup.provider.value } : {}),
      ...(setup.model ? { model: setup.model.value } : {}),
      ...(setup.prompt ? { systemPromptId: setup.prompt.value } : {}),
    };
    void api('/api/chat/send', { method: 'POST', body: JSON.stringify({ fileId: session.id, text, ...picks }) })
      .then(refreshChats)
      .catch(showError);
  });
  card.append(form);
  view.append(card);
  // The chat opens at its latest message, like the app.
  scroll.scrollTop = scroll.scrollHeight;
}

/** Shows one error on the login status line. */
function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (loginStatus) {
    loginStatus.textContent = message;
  }
}

/** The scroll distance that flips the top bars, so a small drift keeps them. */
const BAR_SCROLL_DISTANCE = 8;

/** How long the top bars take to slide (the transition of the style sheet), with a margin. */
const BAR_MOTION_MILLISECONDS = 300;

/** The scroll container the last scroll event read, and the top position it read there. */
let lastScroller: HTMLElement | null = null;
let lastScrollTop = 0;

/** The time the top bars end their slide. */
let barMotionEnd = 0;

/** Slides the top bars up out of the view, or back in. */
function setTopHidden(hidden: boolean): void {
  if (document.body.classList.contains('top-hidden') !== hidden) {
    barMotionEnd = performance.now() + BAR_MOTION_MILLISECONDS;
  }
  document.body.classList.toggle('top-hidden', hidden);
}

/** Hides the top bars while a tab scrolls down, and shows them again while it scrolls up or
   reaches its top. The scroll event does not bubble, so the capture phase on the remote view
   hears every tab and the message area of the chat. Two kinds of event move no bar: the first
   event of a container only sets the baseline, so a tab switch never counts as a scroll, and the
   slide of the bars moves the scroll position of a view that sits at the end of its range. */
function onRemoteScroll(event: Event): void {
  const scroller = event.target;
  if (!(scroller instanceof HTMLElement)) {
    return;
  }
  const top = scroller.scrollTop;
  if (scroller !== lastScroller) {
    lastScroller = scroller;
  } else if (performance.now() >= barMotionEnd) {
    if (top <= 0 || top < lastScrollTop - BAR_SCROLL_DISTANCE) {
      setTopHidden(false);
    } else if (top > lastScrollTop + BAR_SCROLL_DISTANCE) {
      setTopHidden(true);
    }
  }
  lastScrollTop = top;
}
remoteView?.addEventListener('scroll', onRemoteScroll, { capture: true, passive: true });

// The heights of the two top bars stay in the variables of the page: the hidden state slides each
// bar up by its own height (see the style sheet).
for (const [selector, variable] of [
  ['header', '--bar-height'],
  ['main#remote nav', '--tabs-height'],
] as const) {
  const bar = document.querySelector<HTMLElement>(selector);
  if (!bar) {
    continue;
  }
  const measure = (): void => {
    document.documentElement.style.setProperty(variable, `${bar.getBoundingClientRect().height}px`);
  };
  new ResizeObserver(measure).observe(bar);
}

/** Shows one tab of the remote view. The bars return with every tab switch. */
function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
    button.classList.toggle('active', button.dataset.view === name);
  }
  for (const section of document.querySelectorAll<HTMLElement>('main#remote > section')) {
    section.hidden = section.id !== `view-${name}`;
  }
  setTopHidden(false);
  if (name === 'chats') {
    void refreshChats().catch(showError);
  }
}

// The tab navigation.
for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
  button.addEventListener('click', () => {
    showTab(button.dataset.view ?? '');
  });
}

// The login form: the token first, the password as the fallback.
loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = loginToken?.value.trim() ?? '';
  const password = loginPassword?.value ?? '';
  const body = token.length > 0 ? { token } : { password };
  try {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as { ok: boolean; session?: string };
    if (!answer.ok || typeof answer.session !== 'string') {
      if (loginStatus) {
        loginStatus.textContent = 'The credential was refused.';
      }
      return;
    }
    bearer = answer.session;
    localStorage.setItem(STORAGE_KEY, bearer);
    await enterRemote();
  } catch (error) {
    showError(error);
  }
});

// The tool cards of the chats hold the JSON viewer, so the element registers before the first render.
JsonViewerElement.define();

// The boot: the fragment token pairs at once, a stored bearer tries the stream.
void (async () => {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fragmentToken = fragment.get('token');
  if (fragmentToken) {
    localStorage.setItem(STORAGE_KEY, fragmentToken);
    window.history.replaceState(null, '', window.location.pathname);
    bearer = fragmentToken;
    await enterRemote();
    return;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    bearer = stored;
    await enterRemote();
    return;
  }
  showLogin();
})();
