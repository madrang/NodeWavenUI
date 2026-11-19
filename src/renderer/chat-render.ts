/**
 * The message list of the chat column: groups the entries of one chat into message bubbles,
 * tool cards, and agent turn rails, and renders them into the ordered list element.
 * The chat actions behind the bubbles stay with the main app and arrive as callbacks.
 */

import type { ChatImage, ThinkingLevel } from '../providers/provider.js';
import type { ChatEntry, StoredSystemPrompt } from './chat-sessions.js';
import type { SystemPromptSetup } from './plugins.js';
import { readBridge } from '../shared/bridge.js';
import type { JsonViewerElement } from './json-viewer-element.js';
import { appendCodeRuns, renderMarkdown } from './text/render.js';
import { NONE_SYSTEM_PROMPT_SETUP_ID } from './system-prompts.js';

/** The icon strokes of the message action zone, drawn on a 16 by 16 grid. */
const ICON_COPY = 'M6 6h8v8H6z M12 3H2v9';
const ICON_EDIT = 'M2 14h3L14 5l-3-3L2 11z';
const ICON_FORK = 'M4 14V2 M4 7c4 0 8-2 8-5 M4 9c4 0 8 2 8 5';
const ICON_RETRY = 'M13 8a5 5 0 11-1.5-3.5 M12.5 1.5v3h3';
/** The icon strokes of the streaming status line, drawn on a 16 by 16 grid. */
const ICON_CONNECTING = 'M13 8a5 5 0 11-1.5-3.5';
const ICON_ERROR = 'M4 4l8 8 M12 4l-8 8';

/** Reads the one or two words that title an error, from the message the provider produced. */
function errorLabelOf(message: string): string {
  if (message.includes('could not reach')) {
    return 'Unreachable';
  }
  const status = /answered HTTP (\d+)/.exec(message);
  if (status?.[1]) {
    return `HTTP ${status[1]}`;
  }
  return 'Failed';
}

/** One chat tab with its conversation. */
export interface Chat {
  readonly id: number;
  /** The session file id: one uuid per chat, stable across launches. */
  readonly fileId: string;
  readonly title: string;
  /** ISO date and time of the chat creation. It fixes the restore order. */
  readonly createdAt: string;
  readonly entries: ChatEntry[];
  /** True when this tab is the one MCP host tab that logs every session. */
  readonly isMcpHostLog?: boolean;
  /** True while the tab sits in the background and took traffic the user has not seen. */
  unread?: boolean;
  /** The system prompt source the menu holds while the chat has sent no message. */
  pendingSystemPromptId?: string;
  /** The system prompt the chat bound on its first send. It stays for the life of the chat. */
  boundSystemPrompt?: StoredSystemPrompt;
  /** The provider selection the status bar holds while the chat has sent no message. */
  pendingProviderId?: string;
  pendingModel?: string;
  /** The provider and model the chat bound on its first send. They stay for the life of the chat. */
  boundProviderId?: string;
  boundModel?: string;
  /** The context tokens of the last request, when the provider reported usage. */
  contextTokens?: number;
  /** The output tokens of the whole chat, summed over the requests the provider reported. */
  outputTokens?: number;
  /** The reasoning effort of this chat. Unset follows the workspace default. */
  thinkingLevel?: ThinkingLevel;
  /** The dispatchable task this chat runs, set when a dispatch bound it. */
  taskId?: string;
}

/** The one open message editor: the chat it belongs to, the entry index it replaces, and its draft.
 * A missing index marks the draft of a fork, which appends as a new message at the end. */
export interface ChatEditState {
  readonly chatId: number;
  readonly index?: number;
  readonly text: string;
  readonly images?: readonly ChatImage[];
}

/** One render slot: an entry with its list index, the key of the reasoning open-state. */
interface EntrySlot {
  readonly index: number;
  readonly entry: ChatEntry;
}

/** One render group of the message list: one entry, an MCP request with its reply, or one agent
 * turn: the tool calls of an assistant reply with the tool results that answer them. */
type MessageGroup =
  | { readonly kind: 'single'; readonly slot: EntrySlot } |
  { readonly kind: 'pair'; readonly request: EntrySlot; readonly reply: EntrySlot | null } |
  { readonly kind: 'agent'; readonly request: EntrySlot; readonly replies: readonly EntrySlot[] };

/** The chat state and actions the message list renders from and calls back into. */
export interface ChatRendererContext {
  /** Reads the chat the message list renders. */
  activeChat(): Chat | null;
  /** True while one chat runs an agent turn. */
  isTurnRunning(chatId: number): boolean;
  /** Reads the one open message editor, or null. */
  editing(): ChatEditState | null;
  /** Replaces the one open message editor. */
  setEditing(editing: ChatEditState | null): void;
  /** The registered system prompt sources, for the chat menu. */
  readonly promptSources: readonly SystemPromptSetup[];
  /** The source id the chat menu holds: the pending selection, or the default of the workspace. */
  selectedSystemPromptId(chat: Chat): string;
  /** True when the chat already carries a sent message, so its system prompt window has passed. */
  chatHasConversation(chat: Chat): boolean;
  /** Scrolls the latest message into view, but only while the view sits at the bottom. */
  pinChatToBottom(): void;
  /** Sends one queued message at once. */
  sendQueuedNow(chat: Chat, index: number): void | Promise<void>;
  /** Restarts the failed turn of one user message. */
  retryChatFrom(chat: Chat, index: number): void | Promise<void>;
  /** Copies the history before one user message into a new chat tab. */
  forkChatAt(chat: Chat, index: number): void;
  /** Copies one message text to the clipboard. */
  copyEntryText(text: string): void;
  /** Sends the edited draft. */
  saveEditing(): void | Promise<void>;
}

/** Renders the message list of the chat column. */
export class ChatRenderer {
  private readonly chatMessages: HTMLOListElement;
  private readonly context: ChatRendererContext;
  /** The tracked page titles, so a tool call head names the page it targets. */
  private readonly pageTitles = new Map<number, string>();
  /** True while one page title refresh runs, so renders never stack refreshes. */
  private pageTitlesLoading = false;

  constructor(chatMessages: HTMLOListElement, context: ChatRendererContext) {
    this.chatMessages = chatMessages;
    this.context = context;
  }

  /** Groups the entries of one chat for the message list: an MCP request pairs with the reply that
   * follows it, and the tool calls of one agent turn pair with the tool results that answer them.
   * A request still in flight, or brushed aside by an unrelated entry, renders with the wait hint. */
  private groupChatEntries(chat: Chat): readonly MessageGroup[] {
    const groups: MessageGroup[] = [];
    // A message queued while a turn runs stays pinned at the bottom, under the running output.
    const queuedSlots: EntrySlot[] = [];
    let open: EntrySlot | null = null;
    const flush = (): void => {
      if (open) {
        groups.push({ kind: 'pair', request: open, reply: null });
        open = null;
      }
    };
    for (let index = 0; index < chat.entries.length; index += 1) {
      const entry = chat.entries[index];
      if (!entry) {
        continue;
      }
      const slot: EntrySlot = { index, entry };
      if (entry.queued) {
        queuedSlots.push(slot);
        continue;
      }
      if (entry.role === 'user' && entry.json && entry.toolName) {
        // A second request while one waits in flight closes the waiting one as unanswered.
        flush();
        open = slot;
      } else if (entry.role !== 'user' && entry.role !== 'tool' && entry.toolName) {
        if (open) {
          groups.push({ kind: 'pair', request: open, reply: slot });
          open = null;
        } else {
          groups.push({ kind: 'single', slot });
        }
      } else if (entry.role === 'assistant' && entry.toolCalls && entry.toolCalls.length > 0) {
        flush();
        // The tool results follow the assistant reply in call order, until a different role speaks.
        const replies: EntrySlot[] = [];
        let cursor = index + 1;
        while (cursor < chat.entries.length) {
          const candidate = chat.entries[cursor];
          if (!candidate || candidate.role !== 'tool') {
            break;
          }
          replies.push({ index: cursor, entry: candidate });
          cursor += 1;
        }
        groups.push({ kind: 'agent', request: slot, replies });
        index = cursor - 1;
      } else {
        flush();
        groups.push({ kind: 'single', slot });
      }
    }
    flush();
    for (const slot of queuedSlots) {
      groups.push({ kind: 'single', slot });
    }
    return groups;
  }

  /** Builds the reasoning disclosure of one assistant entry, empty until reasoning arrives. */
  private buildReasoningDisclosure(index: number, openReasoning: ReadonlySet<string>): {
    disclosure: HTMLDetailsElement;
    body: HTMLDivElement;
  } {
    const disclosure = document.createElement('details');
    disclosure.className = 'reasoning';
    disclosure.open = openReasoning.has(String(index));
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = 'Reasoning';
    // The collapsed tail carries the latest reasoning words while they stream, and clears when they stop.
    const tail = document.createElement('span');
    tail.className = 'reasoning-tail';
    summary.append(label, tail);
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    disclosure.append(summary, body);
    return { disclosure, body };
  }

  /** Builds one message item of a single entry: the bubble, the tool cards, or the reasoning disclosure.
   * The user, assistant, and error bubbles carry the action zone at their bottom right.
   * Returns null for one error entry the empty slot before it already rendered as its bubble body. */
  private buildMessageItem(
    chat: Chat,
    slot: EntrySlot,
    openReasoning: ReadonlySet<string>,
    isStreaming = false,
  ): HTMLLIElement | null {
    const { index, entry } = slot;
    const editing = this.context.editing();
    if (editing?.chatId === chat.id && editing.index === index) {
      return this.buildMessageEditor(editing);
    }
    const item = document.createElement('li');
    item.dataset.entryIndex = String(index);
    if (entry.role === 'tool' || (entry.toolName && entry.role !== 'user')) {
      item.append(this.buildToolReplyCard(entry));
      return item;
    }
    if (entry.role === 'assistant' && entry.reasoning) {
      // The disclosure mounts with the first reasoning piece, never before it.
      item.className = 'message assistant';
      const { disclosure, body } = this.buildReasoningDisclosure(index, openReasoning);
      body.textContent = entry.reasoning;
      const text = document.createElement('span');
      text.className = 'message-text';
      this.fillEntryText(text, entry);
      item.append(disclosure, text);
      const actions = this.buildMessageActions(chat, slot);
      if (actions) {
        item.append(actions);
      }
      return item;
    }
    if (entry.role === 'assistant' && !entry.content && !isStreaming && chat.entries[index + 1]?.role === 'error') {
      // The turn died before its first piece: one error bubble, the icon and a short label as its
      // title, the provider message as its content.
      const failure = chat.entries[index + 1];
      item.className = 'message error-bubble';
      const head = document.createElement('div');
      head.className = 'error-bubble-head';
      head.append(this.buildIconSvg(ICON_ERROR));
      const title = document.createElement('span');
      title.textContent = errorLabelOf(failure?.content ?? '');
      head.append(title);
      const body = document.createElement('div');
      body.className = 'error-bubble-body';
      body.textContent = failure?.content ?? '';
      item.append(head, body);
      return item;
    }
    if (
      entry.role === 'error' &&
      !entry.toolName &&
      chat.entries[index - 1]?.role === 'assistant' &&
      !chat.entries[index - 1]?.content &&
      !chat.entries[index - 1]?.reasoning &&
      !chat.entries[index - 1]?.toolCalls
    ) {
      // The empty slot before this error rendered the pair as one bubble.
      return null;
    }
    if (entry.role === 'assistant' && !entry.content && isStreaming) {
      // The slot holds nothing yet: the pulsing accent icon of the open connection.
      item.className = 'message stream-status connecting';
      item.append(this.buildIconSvg(ICON_CONNECTING));
      const label = document.createElement('span');
      label.textContent = 'Connecting…';
      item.append(label);
      return item;
    }
    item.className = `message ${entry.role}${entry.queued ? ' queued' : ''}`;
    this.fillEntryText(item, entry);
    if (entry.queued) {
      const marker = document.createElement('span');
      marker.className = 'queued-marker';
      marker.textContent = '(queued)';
      const sendNow = document.createElement('button');
      sendNow.type = 'button';
      sendNow.className = 'queued-send-now';
      sendNow.textContent = 'Send now';
      sendNow.title = 'Sends at the next step of the running turn, without waiting for it to end.';
      sendNow.addEventListener('click', () => {
        void this.context.sendQueuedNow(chat, index);
      });
      marker.append(' ', sendNow);
      item.append(marker);
    }
    if (entry.images && entry.images.length > 0) {
      item.append(this.buildImageStrip(entry.images));
    }
    const actions = this.buildMessageActions(chat, slot);
    if (actions) {
      item.append(actions);
    }
    return item;
  }

  /** Fills one message text element: an assistant reply renders as markdown with highlighted
   * code, every other role renders as plain text. */
  fillEntryText(target: HTMLElement, entry: ChatEntry): void {
    if (entry.role === 'assistant') {
      target.classList.add('md-body');
      renderMarkdown(target, entry.content);
      return;
    }
    target.textContent = entry.content;
  }

  /** Reads the tracked page titles over the bridge and re-renders when one changed. A failed
   * read keeps the titles as they were. */
  private async refreshPageTitles(): Promise<void> {
    if (this.pageTitlesLoading) {
      return;
    }
    this.pageTitlesLoading = true;
    try {
      const bridge = readBridge();
      if (!bridge) {
        return;
      }
      const result = (await bridge.workspace.runWindowTool('list_pages', {})) as { content?: { type: string; text?: string }[] } | null;
      const text = result?.content?.find((block) => block.type === 'text')?.text;
      if (typeof text !== 'string') {
        return;
      }
      const list = JSON.parse(text) as { id?: unknown; title?: unknown }[];
      let changed = false;
      for (const page of list) {
        if (typeof page.id === 'number' && typeof page.title === 'string' && this.pageTitles.get(page.id) !== page.title) {
          this.pageTitles.set(page.id, page.title);
          changed = true;
        }
      }
      if (changed) {
        this.render();
      }
    } catch {
      // The page list stays as it was.
    } finally {
      this.pageTitlesLoading = false;
    }
  }

  /** Reads the target label of a tool call that names a page: the tracked title, or the bare id
   * while the titles load. A miss triggers one refresh. */
  private pageTargetOf(args: unknown): string | null {
    const pageId = (args as Record<string, unknown> | null)?.['pageId'];
    if (typeof pageId !== 'number') {
      return null;
    }
    const known = this.pageTitles.get(pageId);
    if (known) {
      return known;
    }
    void this.refreshPageTitles();
    return `page ${pageId}`;
  }

  /** Builds the action zone of one message: the icon row at the bottom right of the bubble.
   * A user message offers retry, copy, edit, and fork; an assistant reply offers copy. The retry
   * shows only on the user message whose turn ended in an error. The host log and a running turn
   * carry no zone. */
  private buildMessageActions(chat: Chat, slot: EntrySlot): HTMLElement | null {
    const { index, entry } = slot;
    if (chat.isMcpHostLog || this.context.isTurnRunning(chat.id)) {
      return null;
    }
    const zone = document.createElement('div');
    zone.className = 'message-actions';
    if (entry.role === 'user' && !entry.queued) {
      if (this.messageTurnFailed(chat, index)) {
        zone.append(
          this.buildMessageAction('Retry the failed message', ICON_RETRY, () => {
            void this.context.retryChatFrom(chat, index);
          }),
        );
      }
      zone.append(
        this.buildMessageAction('Copy the message text', ICON_COPY, () => {
          this.context.copyEntryText(entry.content);
        }),
        this.buildMessageAction('Edit and resend from here', ICON_EDIT, () => {
          this.context.setEditing({ chatId: chat.id, index, text: entry.content });
          this.render();
        }),
        this.buildMessageAction('Fork into a new tab from here', ICON_FORK, () => {
          this.context.forkChatAt(chat, index);
        }),
      );
      return zone;
    }
    if (entry.role === 'assistant') {
      zone.append(
        this.buildMessageAction('Copy the message text', ICON_COPY, () => {
          this.context.copyEntryText(entry.content);
        }),
      );
      return zone;
    }
    return null;
  }

  /** True when the turn of one user message ended in an error entry: no later sent message owns
   * the conversation between them. */
  private messageTurnFailed(chat: Chat, index: number): boolean {
    for (let cursor = index + 1; cursor < chat.entries.length; cursor += 1) {
      const entry = chat.entries[cursor];
      if (!entry) {
        continue;
      }
      if (entry.role === 'user' && !entry.queued) {
        return false;
      }
      if (entry.role === 'error' && !entry.toolName) {
        return true;
      }
    }
    return false;
  }

  /** Builds one stroke icon svg for the message UI, drawn on a 16 by 16 grid. */
  private buildIconSvg(iconPath: string): SVGSVGElement {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke.setAttribute('d', iconPath);
    icon.append(stroke);
    return icon;
  }

  /** Builds one icon button of the message action zone. */
  private buildMessageAction(title: string, iconPath: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(this.buildIconSvg(iconPath));
    button.addEventListener('click', () => {
      onClick();
    });
    return button;
  }

  /** Builds the open message editor: the pre-filled text area with the send and cancel actions.
   * An entry index replaces that message; a fork draft appends as a new message. */
  private buildMessageEditor(editing: { readonly text: string }): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'message-edit';
    const editor = document.createElement('textarea');
    editor.className = 'message-editor';
    editor.value = editing.text;
    const actions = document.createElement('div');
    actions.className = 'message-edit-actions';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'primary';
    send.textContent = 'Send';
    send.addEventListener('click', () => {
      void this.context.saveEditing();
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      this.context.setEditing(null);
      this.render();
    });
    actions.append(send, cancel);
    item.append(editor, actions);
    editor.addEventListener('input', () => {
      this.fitMessageEditor(editor);
    });
    // Enter sends; Shift+Enter and Ctrl+Enter break the line, like the chat input.
    editor.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.shiftKey || event.isComposing) {
        return;
      }
      event.preventDefault();
      void this.context.saveEditing();
    });
    // The editor still sits detached here, so the fit and the focus wait one frame for the list to mount it.
    requestAnimationFrame(() => {
      this.fitMessageEditor(editor);
      editor.focus();
    });
    // The caret starts at the end, so typing appends to the draft.
    editor.selectionStart = editing.text.length;
    editor.selectionEnd = editing.text.length;
    return item;
  }

  /** Grows the editor text area with its written lines. */
  private fitMessageEditor(editor: HTMLTextAreaElement): void {
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
  }

  /** The text body of one tool reply: a pre when the content carries new lines, so its formatting
   * survives the page layout, a span for a single line. */
  private buildToolText(content: string): HTMLElement {
    const body = document.createElement(content.includes('\n') ? 'pre' : 'span');
    body.className = 'tool-reply-text';
    body.textContent = content;
    return body;
  }

  /** One request/response pair: the framed group card with the labeled request section over the
   * labeled reply section. A missing reply shows the wait hint. */
  private buildToolPair(toolName: string, args: unknown, reply: ChatEntry | null, session?: string): HTMLElement {
    const item = document.createElement('li');
    item.className = 'tool-pair';
    const requestTitle = document.createElement('p');
    requestTitle.className = 'tool-pair-title';
    const requestBadge = document.createElement('span');
    requestBadge.className = 'tool-badge request';
    requestBadge.textContent = '→ Request';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'tool-pair-tool';
    nameLabel.textContent = toolName;
    requestTitle.append(requestBadge, nameLabel);
    // A call that names a page carries its title, so the head reads where the call went.
    const pageTarget = this.pageTargetOf(args);
    if (pageTarget) {
      const targetChip = document.createElement('span');
      targetChip.className = 'tool-pair-target';
      targetChip.textContent = pageTarget;
      requestTitle.append(targetChip);
    }
    if (session) {
      const sessionChip = document.createElement('span');
      sessionChip.className = 'tool-pair-session';
      sessionChip.textContent = session;
      requestTitle.append(sessionChip);
    }
    const requestSection = document.createElement('div');
    requestSection.className = 'tool-pair-section';
    requestSection.append(this.buildToolRequestSection(toolName, args));
    const replyTitle = document.createElement('p');
    replyTitle.className = 'tool-pair-title';
    const replyBadge = document.createElement('span');
    replyBadge.className = reply && reply.role === 'error' ? 'tool-badge reply error' : 'tool-badge reply';
    replyBadge.textContent = '← Reply';
    replyTitle.append(replyBadge);
    item.append(requestTitle, requestSection, replyTitle);
    if (reply) {
      const replySection = document.createElement('div');
      replySection.className = reply.role === 'error' ? 'tool-pair-section error' : 'tool-pair-section';
      if (reply.json) {
        const replyViewer = document.createElement('json-viewer') as JsonViewerElement;
        replyViewer.value = reply.json;
        replySection.append(replyViewer);
      } else {
        replySection.append(this.buildToolText(reply.content));
      }
      if (reply.images && reply.images.length > 0) {
        replySection.append(this.buildImageStrip(reply.images));
      }
      item.append(replySection);
    } else {
      const pending = document.createElement('p');
      pending.className = 'tool-pair-pending';
      pending.textContent = 'waiting for the reply…';
      item.append(pending);
    }
    return item;
  }

  /** Builds the request section of one tool call: an evaluate call shows its expression as
   * highlighted JavaScript, every other call shows the JSON viewer of its arguments. */
  private buildToolRequestSection(toolName: string, args: unknown): HTMLElement {
    const expression = toolName === 'evaluate' ? (args as Record<string, unknown> | null)?.['expression'] : undefined;
    if (typeof expression === 'string') {
      const code = document.createElement('div');
      code.className = 'md-code';
      const label = document.createElement('span');
      label.className = 'md-code-label';
      label.textContent = 'javascript';
      const body = document.createElement('code');
      body.className = 'md-code-body';
      appendCodeRuns(body, expression, 'javascript');
      code.append(label, body);
      return code;
    }
    const viewer = document.createElement('json-viewer') as JsonViewerElement;
    viewer.value = args;
    return viewer;
  }

  /** The reply half of a pair, or a standalone tool reply: the tool name head over the text or viewer. */
  private buildToolReplyCard(entry: ChatEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = entry.role === 'error' ? 'message tool-result tool-error' : 'message tool-result';
    const head = document.createElement('p');
    head.className = 'tool-result-name';
    head.textContent = entry.toolName ?? 'tool';
    card.append(head);
    if (entry.json) {
      const viewer = document.createElement('json-viewer') as JsonViewerElement;
      viewer.value = entry.json;
      card.append(viewer);
    } else {
      card.append(this.buildToolText(entry.content));
    }
    if (entry.images && entry.images.length > 0) {
      card.append(this.buildImageStrip(entry.images));
    }
    return card;
  }

  /** Builds the thumbnail strip of one entry: one small image per attached picture. */
  private buildImageStrip(images: readonly ChatImage[]): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'image-strip';
    for (const image of images) {
      const thumbnail = document.createElement('img');
      thumbnail.src = `data:${image.mimeType};base64,${image.data}`;
      thumbnail.alt = 'image';
      strip.append(thumbnail);
    }
    return strip;
  }

  /** Appends one agent turn: the intro bubble of the assistant reply, one request/response rail per
   * tool call — paired over the tool call id — and any result that lost its call. */
  private appendAgentTurn(group: Extract<MessageGroup, { kind: 'agent' }>, openReasoning: ReadonlySet<string>): void {
    const entry = group.request.entry;
    if (entry.reasoning || entry.content.length > 0) {
      const intro = document.createElement('li');
      intro.dataset.entryIndex = String(group.request.index);
      intro.className = 'message assistant';
      if (entry.reasoning) {
        // The reasoning of a tool-calling reply stays visible once the turn completes.
        const { disclosure, body } = this.buildReasoningDisclosure(group.request.index, openReasoning);
        body.textContent = entry.reasoning;
        intro.append(disclosure);
      }
      if (entry.content.length > 0) {
        const text = document.createElement('span');
        text.className = 'message-text';
        this.fillEntryText(text, entry);
        intro.append(text);
      }
      this.chatMessages.append(intro);
    }
    const calls = entry.toolCalls ?? [];
    const callIds = new Set(calls.map((call) => call.id));
    const replies = new Map<string, EntrySlot>();
    for (const slot of group.replies) {
      if (slot.entry.toolCallId) {
        replies.set(slot.entry.toolCallId, slot);
      }
    }
    for (const call of calls) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = call.arguments;
      }
      const reply = replies.get(call.id);
      this.chatMessages.append(this.buildToolPair(call.name, args, reply ? reply.entry : null));
    }
    for (const slot of group.replies) {
      if (slot.entry.toolCallId && callIds.has(slot.entry.toolCallId)) {
        continue;
      }
      const item = document.createElement('li');
      item.append(this.buildToolReplyCard(slot.entry));
      this.chatMessages.append(item);
    }
  }

  /** Rebuilds the message list of the active chat. Open reasoning disclosures and the open system
   * prompt disclosure stay open across the rebuild. */
  render(): void {
    // An open reasoning disclosure stays open across the rebuild, keyed by the entry index.
    const openReasoning = new Set<string>();
    for (const item of this.chatMessages.children) {
      if (!(item instanceof HTMLElement)) {
        continue;
      }
      const key = item.dataset.entryIndex;
      if (!key) {
        continue;
      }
      const disclosure = item.querySelector(':scope > details.reasoning');
      if (disclosure instanceof HTMLDetailsElement && disclosure.open) {
        openReasoning.add(key);
      }
    }
    // The open state of the system prompt disclosure survives the rebuild the same way.
    const promptDisclosure = this.chatMessages.querySelector(':scope > li.system-prompt-item > details.system-prompt');
    const promptOpen = promptDisclosure instanceof HTMLDetailsElement ? promptDisclosure.open : false;
    this.chatMessages.replaceChildren();
    const chat = this.context.activeChat();
    if (!chat) {
      return;
    }
    this.appendSystemPromptItem(chat, promptOpen);
    // The streaming entry of a busy chat renders as the connecting status until its first piece lands.
    let streamingIndex = -1;
    if (this.context.isTurnRunning(chat.id)) {
      for (let index = chat.entries.length - 1; index >= 0; index -= 1) {
        const candidate = chat.entries[index];
        if (candidate && candidate.role === 'assistant') {
          streamingIndex = index;
          break;
        }
      }
    }
    for (const group of this.groupChatEntries(chat)) {
      if (group.kind === 'single') {
        const item = this.buildMessageItem(chat, group.slot, openReasoning, group.slot.index === streamingIndex);
        if (item) {
          this.chatMessages.append(item);
        }
        continue;
      }
      if (group.kind === 'agent') {
        this.appendAgentTurn(group, openReasoning);
        continue;
      }
      const reply = group.reply ? group.reply.entry : null;
      this.chatMessages.append(
        this.buildToolPair(
          group.request.entry.toolName ?? group.request.entry.content,
          group.request.entry.json,
          reply,
          group.request.entry.mcpSession,
        ),
      );
    }
    // The fork draft carries no entry yet, so its editor renders after the copied history.
    const editing = this.context.editing();
    if (editing?.chatId === chat.id && !Object.hasOwn(editing, 'index')) {
      this.chatMessages.append(this.buildMessageEditor(editing));
    }
    this.context.pinChatToBottom();
  }

  /** Renders the system prompt element first in the message list: the source menu before the first
   * sent message, the collapsed bound prompt after it. The none source and the host tab render nothing.
   * A chat that predates the prompt, or carries messages without one, renders nothing: its window passed. */
  private appendSystemPromptItem(chat: Chat, promptOpen: boolean): void {
    if (chat.isMcpHostLog || this.context.promptSources.length === 0) {
      return;
    }
    const bound = chat.boundSystemPrompt;
    if (bound) {
      if (bound.sourceId === NONE_SYSTEM_PROMPT_SETUP_ID || bound.text.length === 0) {
        return;
      }
      const item = document.createElement('li');
      item.className = 'system-prompt-item';
      const disclosure = document.createElement('details');
      disclosure.className = 'system-prompt';
      disclosure.open = promptOpen;
      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'system-prompt-title';
      label.textContent = bound.title;
      summary.append(label);
      const body = document.createElement('div');
      body.className = 'system-prompt-body';
      body.textContent = bound.text;
      disclosure.append(summary, body);
      item.append(disclosure);
      this.chatMessages.append(item);
      return;
    }
    if (this.context.chatHasConversation(chat)) {
      return;
    }
    const selected = this.context.selectedSystemPromptId(chat);
    const item = document.createElement('li');
    // The menu variant carries its own emphasis: centered and accented before the first send.
    item.className = 'system-prompt-item system-prompt-menu';
    const label = document.createElement('span');
    label.className = 'system-prompt-menu-label';
    label.textContent = 'System prompt';
    const select = document.createElement('select');
    select.className = 'system-prompt-select';
    select.title = 'The system prompt of the first message. The chat keeps it after the send.';
    for (const source of this.context.promptSources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label;
      select.append(option);
    }
    select.value = this.context.promptSources.some((source) => source.id === selected) ?
      selected :
      (this.context.promptSources[0]?.id ?? '');
    select.addEventListener('change', () => {
      chat.pendingSystemPromptId = select.value;
    });
    item.append(label, select);
    this.chatMessages.append(item);
  }
}
