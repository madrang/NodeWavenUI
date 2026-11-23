/**
 * The phone page of the remote control. It pairs with the token from the URL fragment or a
 * manual entry, keeps the bearer in the local storage, renders the permission asks, the patch
 * proposals, the task reviews, and the chat sessions, and answers through the API of the worker
 * core. The event stream rides a fetch stream with the authorization header, so no credential
 * lands in a URL. The replies and the patch diffs render through the shared text stack of the app.
 */

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
  readonly result: string | null;
}

interface ChatSessionDto {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly entries: { role: string; content: string }[];
}

const STORAGE_KEY = 'nodewavenui-remote-token';

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
function applyState(next: { permission?: unknown; patches?: unknown; tasks?: unknown }): void {
  if (next.permission && typeof next.permission === 'object') {
    state.permission = next.permission as typeof state.permission;
  }
  if (next.patches && typeof next.patches === 'object') {
    state.patches = next.patches as typeof state.patches;
  }
  if (next.tasks && typeof next.tasks === 'object') {
    state.tasks = next.tasks as typeof state.tasks;
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
    const snapshot = payload as { permission?: unknown; patches?: unknown; tasks?: unknown };
    if (snapshot.permission && typeof snapshot.permission === 'object') {
      state.permission = snapshot.permission as typeof state.permission;
    }
    if (snapshot.patches && typeof snapshot.patches === 'object') {
      state.patches = snapshot.patches as typeof state.patches;
    }
    if (snapshot.tasks && typeof snapshot.tasks === 'object') {
      state.tasks = snapshot.tasks as typeof state.tasks;
    }
    renderApprovals();
    renderPatches();
    renderTasks();
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
    applyState((await api('/api/state')) as typeof state);
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

/** Renders the tasks view. */
function renderTasks(): void {
  const view = document.querySelector<HTMLElement>('#view-tasks');
  if (!view) {
    return;
  }
  view.replaceChildren();
  const reviews = state.tasks.records.filter((task) => task.status === 'review');
  if (reviews.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'status';
    empty.textContent = 'No task waits for review.';
    view.append(empty);
    return;
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

/** Renders the chats view. */
function renderChats(sessions: readonly ChatSessionDto[]): void {
  const view = document.querySelector<HTMLElement>('#view-chats');
  if (!view) {
    return;
  }
  view.replaceChildren();
  const list = document.createElement('div');
  list.className = 'card chat-session-list';
  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = 'chat-session';
    button.textContent = session.title;
    button.addEventListener('click', () => {
      renderChat(session);
    });
    list.append(button);
  }
  view.append(list);
  if (activeChat) {
    renderChat(sessions.find((session) => session.id === activeChat?.id) ?? null);
  }
}

/** Renders one chat with its send box. */
function renderChat(session: ChatSessionDto | null): void {
  activeChat = session;
  const view = document.querySelector<HTMLElement>('#view-chats');
  if (!view) {
    return;
  }
  const existing = view.querySelector('.chat-view');
  existing?.remove();
  if (!session) {
    return;
  }
  const card = document.createElement('div');
  card.className = 'chat-view';
  const scroll = document.createElement('div');
  scroll.className = 'chat-scroll';
  for (const entry of session.entries.slice(-40)) {
    // A persisted empty reply renders nothing, like the app.
    if (entry.role === 'assistant' && entry.content.length === 0) {
      continue;
    }
    const line = document.createElement('div');
    line.className = `entry ${entry.role}`;
    // The replies carry markdown like the app; the user lines stay plain text.
    if (entry.role === 'assistant') {
      const body = document.createElement('div');
      body.className = 'md-body';
      renderMarkdown(body, entry.content);
      line.append(body);
    } else {
      line.textContent = entry.content;
    }
    scroll.append(line);
  }
  card.append(scroll);
  const form = document.createElement('form');
  form.id = 'chat-send';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Message';
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  form.append(input, send);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) {
      return;
    }
    input.value = '';
    void api('/api/chat/send', { method: 'POST', body: JSON.stringify({ fileId: session.id, text }) })
      .then(() => api('/api/chat/sessions'))
      .then((fresh) => {
        renderChats(fresh as readonly ChatSessionDto[]);
      })
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

// The tab navigation.
for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>('nav button')) {
      other.classList.toggle('active', other === button);
    }
    const name = button.dataset.view;
    for (const section of document.querySelectorAll<HTMLElement>('main#remote > section')) {
      section.hidden = section.id !== `view-${name}`;
    }
    if (name === 'chats') {
      void api('/api/chat/sessions')
        .then((sessions) => {
          renderChats(sessions as readonly ChatSessionDto[]);
        })
        .catch(showError);
    }
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
