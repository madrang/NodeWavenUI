/**
 * The review view of one patch: a workarea view of the center workspace that shows the changed
 * lines of the unified diff and carries the answers of the user. Approve applies the patch to
 * the live file, with the choice to force a new task for the next writes. Deny refuses it and
 * sends the denial to the agent of its chat, with the written comment when one rides along.
 * Dismiss refuses it silently, so the agent hears nothing. A failed apply keeps the record as a
 * conflict, so the review shows the reason and the patch stays.
 */

import { buildDiff } from './text/render.js';
import { getWorkarea, type WorkareaView } from './workarea.js';
import { patchWaitsForReview, type PatchRecord, type PatchStore } from './patch-store.js';

/** The id of the shared review view. A CTRL open registers a per-patch view beside it. */
const SHARED_VIEW_ID = 'patch-review';

/** Builds the answer controls of one waiting patch and wires them to the store. */
function buildControls(store: PatchStore, record: PatchRecord, rerender: () => void): HTMLElement {
  const controls = document.createElement('div');
  controls.className = 'review-controls';
  const comment = document.createElement('textarea');
  comment.className = 'review-comment';
  comment.placeholder = 'An optional comment for the agent, sent with the denial.';
  comment.rows = 2;
  const actions = document.createElement('div');
  actions.className = 'review-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'review-approve';
  approve.textContent = 'Approve';
  const forceNewTask = document.createElement('label');
  forceNewTask.className = 'review-choice';
  const forceBox = document.createElement('input');
  forceBox.type = 'checkbox';
  forceNewTask.append(forceBox, document.createTextNode('Force a new task for the next writes'));
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'review-deny';
  deny.textContent = 'Deny';
  deny.title = 'Denies the patch. The comment, when written, rides to the agent.';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'review-dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.title = 'Denies the patch without telling the agent.';
  approve.addEventListener('click', () => {
    void (async () => {
      const state = await store.apply(record.id);
      if (state === 'applied' && forceBox.checked) {
        await store.closeTask(record.chatId);
      }
      rerender();
    })();
  });
  deny.addEventListener('click', () => {
    const text = comment.value.trim();
    comment.value = '';
    void store.deny(record.id, text.length > 0 ? text : null).then(rerender);
  });
  dismiss.addEventListener('click', () => {
    comment.value = '';
    void store.dismiss(record.id).then(rerender);
  });
  actions.append(approve, forceNewTask, deny, dismiss);
  controls.append(comment, actions);
  return controls;
}

/**
 * Opens the review of one patch in the center workspace. The default reuses the shared review
 * view, so the review replaces the open tab, and a separate open registers one view per patch.
 *
 * @param store The patch store that holds the record.
 * @param id The patch record id.
 * @param separateTab True to open the patch in its own view beside the shared one.
 */
export function openPatchReviewView(store: PatchStore, id: number, separateTab: boolean): void {
  const record = store.patch(id);
  if (!record) {
    return;
  }
  const viewId = separateTab ? `patch-review-${id}` : SHARED_VIEW_ID;
  getWorkarea().unregister(viewId);
  const content = document.createElement('div');
  content.className = 'review-view';
  /** Drops the store subscription of this view. */
  let dispose = (): void => {};
  const view: WorkareaView = {
    label: `Patch ${record.id}`,
    badge: 'patch',
    title: record.path,
    content,
    onClose: () => {
      dispose();
      getWorkarea().unregister(viewId);
      content.remove();
    },
  };
  const rerender = (): void => {
    const current = store.patch(id);
    if (!current) {
      getWorkarea().unregister(viewId);
      return;
    }
    content.replaceChildren(...buildReview(store, current, rerender));
    getWorkarea().setLabel(viewId, `Patch ${current.id} · ${current.state}`);
  };
  dispose = store.subscribe(rerender);
  getWorkarea().register(viewId, view);
  rerender();
}

/** Builds the whole review body of one record: the facts, the conflict note, the diff, then the controls. */
function buildReview(store: PatchStore, record: PatchRecord, rerender: () => void): HTMLElement[] {
  const header = document.createElement('header');
  header.className = 'review-header';
  const path = document.createElement('div');
  path.className = 'review-path';
  path.textContent = record.path;
  const facts = document.createElement('div');
  facts.className = 'review-facts';
  const task = record.taskId ? store.listTasks().find((candidate) => candidate.id === record.taskId) : undefined;
  // The header carries the settled state: the conflict reason or the comment of the denial.
  const note = record.comment ? ` · ${record.comment}` : '';
  facts.textContent = `${task?.title ?? 'no task'} · ${record.state}${note}`;
  header.append(path, facts);
  const parts: HTMLElement[] = [header];
  if (patchWaitsForReview(record.state) && record.state === 'conflicted') {
    const banner = document.createElement('div');
    banner.className = 'review-conflict';
    banner.textContent = `The patch conflicts: ${record.comment ?? 'it no longer applies.'} Deny it with a comment for the agent, or dismiss it silently.`;
    parts.push(banner);
  }
  parts.push(buildDiff(record.patch, record.path));
  if (patchWaitsForReview(record.state)) {
    parts.push(buildControls(store, record, rerender));
  }
  return parts;
}
