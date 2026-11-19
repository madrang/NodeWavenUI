/**
 * The settings view of the workarea. The markup lives in the view folder as `template.html`
 * with `${token}` placeholders, and the styles live beside it as `styles.css`; this module
 * loads both, resolves the placeholders against the loaded dictionary, and mounts the content
 * into the settings pane the workspace shell holds. The shell keeps the pane element, because
 * the top bar toggles it; everything inside belongs to the view.
 */

import { requireElement } from '../../dom.js';
import { localizeHTML } from '../../locale/index.js';
import { adoptStyles, loadTemplate } from '../../ui/template.js';

/**
 * Mounts the settings view into the settings pane of the workspace shell.
 *
 * @throws Error when an asset fails to load.
 */
export async function mountSettingsView(): Promise<void> {
  const pane = requireElement<HTMLElement>('#pane-settings');
  await Promise.all([
    loadTemplate('views/settings/template.html'),
    adoptStyles('views/settings/styles.css'),
  ]).then(async ([template]) => {
    localizeHTML(template.content);
    pane.append(template.content);
  });
}
