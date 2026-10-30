/**
 * The `json-viewer` custom element: one collapsible, highlighted display of one structured value.
 * Any surface can drop the element in and set its value, so the chat tabs, the settings pane, or a
 * future inspector all reuse the same display.
 *
 * Usage: set the `value` property. Objects and arrays render as collapsible nodes, open near the
 * root and collapsed deeper. Every other value renders as one highlighted line.
 */

/** Containers at a depth below this number render expanded. Deeper containers start collapsed. */
const OPEN_DEPTH = 2;

/** One entry of a container value. */
interface JsonEntry {
  /** The property name, or null for the root value and for array items. */
  readonly key: string | null;
  readonly value: unknown;
}

/** Reads the entries of one container value, or null when the value is not a container. */
function containerEntries(value: unknown): readonly JsonEntry[] | null {
  if (Array.isArray(value)) {
    return value.map((item) => ({ key: null, value: item }));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([entryKey, item]) => ({ key: entryKey, value: item }));
  }
  return null;
}

/** The token class of one leaf value. */
function tokenClass(value: unknown): string {
  if (typeof value === 'string') {
    return 'json-string';
  }
  if (typeof value === 'number') {
    return 'json-number';
  }
  if (typeof value === 'boolean') {
    return 'json-boolean';
  }
  if (value === null || value === undefined) {
    return 'json-null';
  }
  // An empty container renders inline. A symbol or a function is a value JSON cannot carry.
  return typeof value === 'object' ? 'json-punct' : 'json-null';
}

/** The token text of one leaf value. */
function tokenText(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** One collapsible JSON display. */
export class JsonViewerElement extends HTMLElement {
  private json: unknown = null;

  /** Registers the element once. */
  static define(): void {
    if (customElements.get('json-viewer') === undefined) {
      customElements.define('json-viewer', JsonViewerElement);
    }
  }

  /** The value the display shows. Setting it re-renders the display. */
  set value(value: unknown) {
    this.json = value;
    this.render();
  }

  private render(): void {
    this.replaceChildren(this.buildNode(this.json, null, 0));
  }

  /** Builds one tree node: a collapsible container, or one highlighted row for a leaf. */
  private buildNode(value: unknown, key: string | null, depth: number): HTMLElement {
    const entries = containerEntries(value);
    if (entries === null || entries.length === 0) {
      return this.buildLeafRow(value, key);
    }
    const isArray = Array.isArray(value);
    const node = document.createElement('details');
    node.className = 'json-node';
    node.open = depth < OPEN_DEPTH;
    const summary = document.createElement('summary');
    summary.className = 'json-row';
    this.appendKey(summary, key);
    const openMark = document.createElement('span');
    openMark.className = 'json-punct';
    openMark.textContent = isArray ? '[' : '{';
    const count = document.createElement('span');
    count.className = 'json-count';
    count.textContent = String(entries.length);
    const closedMark = document.createElement('span');
    closedMark.className = 'json-punct json-closed';
    closedMark.textContent = isArray ? ']' : '}';
    summary.append(openMark, count, closedMark);
    const children = document.createElement('div');
    children.className = 'json-children';
    for (const entry of entries) {
      children.append(this.buildNode(entry.value, entry.key, depth + 1));
    }
    const close = document.createElement('div');
    close.className = 'json-row';
    const closeMark = document.createElement('span');
    closeMark.className = 'json-punct';
    closeMark.textContent = isArray ? ']' : '}';
    close.append(closeMark);
    node.append(summary, children, close);
    return node;
  }

  /** Builds the row of one leaf value: the key prefix and the value token. */
  private buildLeafRow(value: unknown, key: string | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'json-row';
    this.appendKey(row, key);
    const token = document.createElement('span');
    token.className = `json-token ${tokenClass(value)}`;
    token.textContent = tokenText(value);
    row.append(token);
    return row;
  }

  /** Appends the quoted key prefix to one row, when the row carries a key. */
  private appendKey(row: HTMLElement, key: string | null): void {
    if (key === null) {
      return;
    }
    const name = document.createElement('span');
    name.className = 'json-key';
    name.textContent = JSON.stringify(key);
    const colon = document.createElement('span');
    colon.className = 'json-punct';
    colon.textContent = ': ';
    row.append(name, colon);
  }
}
