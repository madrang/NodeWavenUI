/**
 * Renders plugin UI definitions.
 * A plugin describes its configuration fields as data (`PluginFieldDefinition` from `plugins.ts`), and this module draws them with the app styling.
 * Every surface that configures a plugin (the setup wizard, the settings pane) shows the same controls through this one renderer, so plugin UI never gets tracked independently of the plugin.
 */

import type { PluginFieldDefinition } from '../plugins.js';

/** One rendered plugin UI definition. */
export class PluginFieldGroup {
  private readonly inputs: ReadonlyMap<string, HTMLInputElement | HTMLSelectElement>;

  private constructor(inputs: ReadonlyMap<string, HTMLInputElement | HTMLSelectElement>) {
    this.inputs = inputs;
  }

  /**
   * Renders one UI definition into a container, replacing its content.
   *
   * @param container The element the fields render into.
   * @param fields The UI definition of a plugin contribution.
   * @returns The rendered group.
   */
  static mount(container: HTMLElement, fields: readonly PluginFieldDefinition[]): PluginFieldGroup {
    container.replaceChildren();
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const field of fields) {
      const label = document.createElement('label');
      label.className = 'field';
      label.textContent = field.label;
      let input: HTMLInputElement | HTMLSelectElement;
      if (field.kind === 'select') {
        const select = document.createElement('select');
        for (const option of field.options ?? []) {
          const element = document.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          element.disabled = option.enabled === false;
          select.append(element);
        }
        input = select;
      } else {
        const text = document.createElement('input');
        text.type = field.kind === 'password' ? 'password' : 'text';
        text.autocomplete = field.kind === 'password' ? 'new-password' : 'off';
        if (field.placeholder !== undefined) {
          text.placeholder = field.placeholder;
        }
        input = text;
      }
      if (field.prefill !== undefined) {
        input.value = field.prefill;
      }
      label.append(input);
      container.append(label);
      inputs.set(field.id, input);
    }
    return new PluginFieldGroup(inputs);
  }

  /**
   * Reads the current values of the rendered fields.
   *
   * @returns The values by field id.
   */
  readValues(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [id, input] of this.inputs) {
      values[id] = input.value;
    }
    return values;
  }
}
