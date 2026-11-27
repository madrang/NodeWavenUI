/**
 * The chat cards both chat surfaces render: the grouping of the entries of one chat, the reasoning
 * disclosure of a reply, the tool call cards, and the standalone tool reply. Every builder here
 * constructs elements and reads no bridge, so the workspace chat view and the phone page of the
 * remote control import this module and link the style sheet beside it. One card list, two
 * surfaces, no drift. The chat actions behind the bubbles stay with each surface.
 */

import type { CoreChatEntry } from '../../shared/core-api.js';
import type { JsonViewerElement } from '../json-viewer-element.js';
import { appendCodeRuns, renderMarkdown } from '../text/render.js';

/** One render slot: an entry with its list index, the key of the reasoning open-state. */
export interface EntrySlot {
  readonly index: number;
  readonly entry: CoreChatEntry;
}

/** One render group of a message list: one entry, an MCP request with its reply, or one agent
 * turn: the tool calls of an assistant reply with the tool results that answer them. */
export type MessageGroup =
  | { readonly kind: 'single'; readonly slot: EntrySlot } |
  { readonly kind: 'pair'; readonly request: EntrySlot; readonly reply: EntrySlot | null } |
  { readonly kind: 'agent'; readonly request: EntrySlot; readonly replies: readonly EntrySlot[] };

/** The element one card takes: a list item of the workspace message list, a division in the
 * message area of the phone page. */
export type CardTag = 'div' | 'li';

/** The chips of one pair card head, after the tool name. */
export interface ToolPairChips {
  /** Reads the title of the page a call names, or null. The card shows it, so the head reads
   * where the call went. */
  pageTargetOf?(args: unknown): string | null;
  /** The short id of the MCP connection that made the call. */
  session?: string;
}

/** Groups the entries of one chat for a message list: an MCP request pairs with the reply that
 * follows it, and the tool calls of one agent turn pair with the tool results that answer them.
 * A request still in flight, or brushed aside by an unrelated entry, renders with the wait hint. */
export function groupChatEntries(entries: readonly CoreChatEntry[]): MessageGroup[] {
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
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
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
      while (cursor < entries.length) {
        const candidate = entries[cursor];
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
export function buildReasoningDisclosure(open: boolean): {
  disclosure: HTMLDetailsElement;
  body: HTMLDivElement;
} {
  const disclosure = document.createElement('details');
  disclosure.className = 'reasoning';
  disclosure.open = open;
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

/** Appends the reasoning disclosure of one reply bubble when the entry holds reasoning. The
 * disclosure mounts with the first reasoning piece, never before it. */
export function appendReasoning(bubble: HTMLElement, entry: CoreChatEntry, open: boolean): void {
  if (!entry.reasoning) {
    return;
  }
  const { disclosure, body } = buildReasoningDisclosure(open);
  body.textContent = entry.reasoning;
  bubble.append(disclosure);
}

/** The class of one reply bubble over its base class. A reply that holds its reasoning and no
 * answer reads as a small card, like the system prompt. */
export function replyBubbleClass(baseClass: string, entry: CoreChatEntry): string {
  return entry.reasoning && !entry.content ? `${baseClass} reasoning-only` : baseClass;
}

/** Fills one message text element: an assistant reply renders as markdown with highlighted
 * code, every other role renders as plain text. */
export function fillEntryText(target: HTMLElement, entry: CoreChatEntry): void {
  if (entry.role === 'assistant') {
    target.classList.add('md-body');
    renderMarkdown(target, entry.content);
    return;
  }
  target.textContent = entry.content;
}

/** Appends the answer of one reply as its text element. */
export function appendAnswer(bubble: HTMLElement, entry: CoreChatEntry): void {
  const text = document.createElement('span');
  text.className = 'message-text';
  fillEntryText(text, entry);
  bubble.append(text);
}

/** Builds the request section of one tool call: an evaluate call shows its expression as
 * highlighted JavaScript, every other call shows the JSON viewer of its arguments. */
export function buildToolRequestSection(toolName: string, args: unknown): HTMLElement {
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

/** The text body of one tool reply: a pre when the content carries new lines, so its formatting
 * survives the page layout, a span for a single line. */
export function buildToolText(content: string): HTMLElement {
  const body = document.createElement(content.includes('\n') ? 'pre' : 'span');
  body.className = 'tool-reply-text';
  body.textContent = content;
  return body;
}

/** One request/response pair: the framed group card with the labeled request section over the
 * labeled reply section. A missing reply shows the wait hint. */
export function buildToolPair(
  tag: CardTag,
  toolName: string,
  args: unknown,
  reply: CoreChatEntry | null,
  chips: ToolPairChips = {},
): HTMLElement {
  const item = document.createElement(tag);
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
  const pageTarget = chips.pageTargetOf?.(args) ?? null;
  if (pageTarget) {
    const targetChip = document.createElement('span');
    targetChip.className = 'tool-pair-target';
    targetChip.textContent = pageTarget;
    requestTitle.append(targetChip);
  }
  if (chips.session) {
    const sessionChip = document.createElement('span');
    sessionChip.className = 'tool-pair-session';
    sessionChip.textContent = chips.session;
    requestTitle.append(sessionChip);
  }
  const requestSection = document.createElement('div');
  requestSection.className = 'tool-pair-section';
  requestSection.append(buildToolRequestSection(toolName, args));
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
      replySection.append(buildToolText(reply.content));
    }
    if (reply.images && reply.images.length > 0) {
      replySection.append(buildImageStrip(reply.images));
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

/** The reply half of a pair, or a standalone tool reply: the tool name head over the text or viewer. */
export function buildToolReplyCard(entry: CoreChatEntry): HTMLElement {
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
    card.append(buildToolText(entry.content));
  }
  if (entry.images && entry.images.length > 0) {
    card.append(buildImageStrip(entry.images));
  }
  return card;
}

/** Builds the thumbnail strip of one entry: one small image per attached picture. */
export function buildImageStrip(images: NonNullable<CoreChatEntry['images']>): HTMLElement {
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

/** Places one card: under its own list item in the workspace list, or as it is on the phone page. */
function cardItem(card: HTMLElement, tag: CardTag): HTMLElement {
  if (tag === 'div') {
    return card;
  }
  const item = document.createElement('li');
  item.append(card);
  return item;
}

/** Appends the tool call cards of one agent reply: one pair per call, matched over the call id
 * with the result that answers it, then every result that lost its call. */
export function appendToolCalls(
  container: HTMLElement,
  request: CoreChatEntry,
  replies: readonly CoreChatEntry[],
  tag: CardTag,
  chips: ToolPairChips = {},
): void {
  const calls = request.toolCalls ?? [];
  const callIds = new Set(calls.map((call) => call.id));
  const byCallId = new Map<string, CoreChatEntry>();
  for (const reply of replies) {
    if (reply.toolCallId) {
      byCallId.set(reply.toolCallId, reply);
    }
  }
  for (const call of calls) {
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      args = call.arguments;
    }
    container.append(buildToolPair(tag, call.name, args, byCallId.get(call.id) ?? null, chips));
  }
  for (const reply of replies) {
    if (reply.toolCallId && callIds.has(reply.toolCallId)) {
      continue;
    }
    container.append(cardItem(buildToolReplyCard(reply), tag));
  }
}

/** The typed answer of one ask card. A surface that rebuilds its cards passes it, so the field
 * starts with the typed text and reports each change. */
export interface TaskAskDraft {
  readonly text: string;
  readonly keep: (text: string) => void;
}

/** Builds the ask card of a blocked task: the question of its session, and the field that answers
 * it. Every surface that lists the task builds the same card, and the answer callback of the
 * surface carries the text to the engine. */
export function buildTaskAskCard(
  question: string,
  answer: (text: string) => void,
  draft?: TaskAskDraft,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'task-ask-card';
  const label = document.createElement('span');
  label.className = 'task-ask-label';
  label.textContent = 'The session asks';
  const text = document.createElement('p');
  text.className = 'task-ask-question';
  text.textContent = question;
  const form = document.createElement('form');
  form.className = 'task-ask-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-ask-input';
  input.placeholder = 'Your answer';
  input.required = true;
  input.value = draft?.text ?? '';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'task-ask-send';
  send.textContent = 'Answer';
  form.append(input, send);
  input.addEventListener('input', () => {
    draft?.keep(input.value);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const trimmed = input.value.trim();
    if (trimmed) {
      answer(trimmed);
    }
  });
  card.append(label, text, form);
  return card;
}
