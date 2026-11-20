/**
 * The chat view of the workspace shell. The markup lives in the view folder as `template.html`
 * with `${token}` placeholders, and the styles live beside it as `styles.css`; this module
 * loads both, resolves the placeholders against the loaded dictionary, and mounts the content
 * into the chat column the shell holds. The shell keeps the column element and its resize
 * handle, because the column layout belongs to the frame; everything inside belongs to the
 * view. The boot awaits this mount before the handoff arrives, so every id the app wiring
 * reads exists by then.
 */

import { requireElement } from '../../dom.js';
import { localizeHTML } from '../../locale/index.js';
import { adoptStyles, loadTemplate } from '../../ui/template.js';

/**
 * Mounts the chat view into the chat column of the workspace shell.
 *
 * @throws Error when an asset fails to load.
 */
export async function mountChatView(): Promise<void> {
  const column = requireElement<HTMLElement>('#chat-column');
  await Promise.all([
    loadTemplate('views/chat/template.html'),
    adoptStyles('views/chat/styles.css'),
  ]).then(async ([template]) => {
    localizeHTML(template.content);
    column.append(template.content);
  });
}
