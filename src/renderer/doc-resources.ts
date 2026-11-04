/**
 * The harness documents of the app: markdown files under `docs/` that ship with the renderer assets.
 * Both agent surfaces serve them: the MCP host as resources, the chat agent through the `read` tool
 * with the `harness:` scheme.
 */

/** One harness document. */
export interface HarnessDoc {
  /** The resource URI both surfaces serve. */
  readonly uri: string;
  /** The file path relative to the renderer directory. */
  readonly file: string;
  readonly name: string;
  readonly description: string;
}

/** The documents, in list order. */
const DOCS: readonly HarnessDoc[] = [
  {
    uri: 'harness:///nodewavenui/overview.md',
    file: 'docs/overview.md',
    name: 'overview',
    description: 'What NodeWavenUI is, its three agent surfaces, and the document index.',
  },
  {
    uri: 'harness:///nodewavenui/mcp-host-tools.md',
    file: 'docs/mcp-host-tools.md',
    name: 'mcp-host-tools',
    description: 'The MCP host tool reference: windows, sessions, evaluate, permissions.',
  },
  {
    uri: 'harness:///nodewavenui/AGENTS.md',
    file: 'docs/AGENTS.md',
    name: 'AGENTS',
    description: 'The base system prompt of the chat agent: the tool surface and the entry document.',
  },
  {
    uri: 'harness:///nodewavenui/chat-agent-tools.md',
    file: 'docs/chat-agent-tools.md',
    name: 'chat-agent-tools',
    description: 'The chat agent tools, the approval cards, and the MCP endpoint modes.',
  },
  {
    uri: 'harness:///nodewavenui/read-uris.md',
    file: 'docs/read-uris.md',
    name: 'read-uris',
    description: 'The read URI schemes: harness, file, storage, and MCP resources.',
  },
  {
    uri: 'harness:///nodewavenui/nodewavenmcp-api.md',
    file: 'docs/nodewavenmcp-api.md',
    name: 'nodewavenmcp-api',
    description: 'The nodewavenMcp page API for evaluated code.',
  },
  {
    uri: 'harness:///nodewavenui/graphs.md',
    file: 'docs/graphs.md',
    name: 'graphs',
    description: 'The Graphs window: open it and draw SVG graphs through nodewavenGraphs.',
  },
  {
    uri: 'harness:///nodewavenui/editor.md',
    file: 'docs/editor.md',
    name: 'editor',
    description: 'The Editor window: open it and edit text through nodewavenEditor.',
  },
  {
    uri: 'harness:///nodewavenui/project-layout.md',
    file: 'docs/project-layout.md',
    name: 'project-layout',
    description: 'The source tree: what lives where in the NodeWavenUI project.',
  },
];

/** The MIME type of every harness document. */
export const HARNESS_DOC_MIME_TYPE = 'text/markdown';

/** The uris the built-in documents claim. A plugin harness document must not take one of them. */
export const BUILT_IN_HARNESS_DOC_URIS: readonly string[] = DOCS.map((doc) => doc.uri);

/** The overview document, the entry point every agent reads first. It lists the live plugin documents. */
const OVERVIEW_URI = 'harness:///nodewavenui/overview.md';

const cache = new Map<string, string>();

/** The harness documents plugins registered, set once at startup. They appear only while their plugin loads. */
let pluginDocs: readonly HarnessDoc[] = [];

/**
 * Sets the harness documents of the loaded plugins.
 * The startup wiring calls this after the plugin folders load, so a plugin document never
 * outlives its plugin: a removed or disabled plugin folder contributes nothing.
 * The overview cache drops, so the entry point composes with the new list on its next read.
 *
 * @param docs The documents the plugin manager registered.
 */
export function setPluginHarnessDocs(docs: readonly HarnessDoc[]): void {
  pluginDocs = [...docs];
  cache.delete(OVERVIEW_URI);
}

/**
 * Builds the plugin document section of the overview.
 *
 * @param docs The registered plugin documents.
 * @returns The section text, or null when no plugin registered a document.
 */
export function pluginDocumentSection(docs: readonly HarnessDoc[]): string | null {
  if (docs.length === 0) {
    return null;
  }
  const lines = docs.map((doc) => `- \`${doc.uri}\` — ${doc.description}`);
  return `# Plugin documents\n\nThese documents come from the enabled plugin folders. They leave with their plugin.\n\n${lines.join('\n')}\n`;
}

/** One resource entry as the MCP resources/list answer carries it. */
export interface HarnessDocInfo {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** Lists the harness documents: the built-ins first, then the plugin documents. */
export function listHarnessDocs(): readonly HarnessDocInfo[] {
  return [...DOCS, ...pluginDocs].map((doc) => ({
    uri: doc.uri,
    name: doc.name,
    description: doc.description,
    mimeType: HARNESS_DOC_MIME_TYPE,
  }));
}

/**
 * Reads one harness document.
 *
 * @param uri The resource URI.
 * @returns The document text.
 * @throws Error when no document matches. The message names the valid URIs.
 */
export async function readHarnessDoc(uri: string): Promise<string> {
  const cached = cache.get(uri);
  if (cached !== undefined) {
    return cached;
  }
  const doc = [...DOCS, ...pluginDocs].find((candidate) => candidate.uri === uri);
  if (doc === undefined) {
    const list = [...DOCS, ...pluginDocs].map((candidate) => candidate.uri).join(', ');
    throw new Error(`No harness document matches ${uri}. Valid: ${list}.`);
  }
  const response = await fetch(doc.file);
  if (!response.ok) {
    throw new Error(`The harness document ${doc.file} answered HTTP ${response.status}.`);
  }
  const text = await response.text();
  // The overview is the entry point, so it carries the live plugin documents: an agent that
  // reads only the overview still learns they exist.
  const composed = doc.uri === OVERVIEW_URI ? withPluginSection(text) : text;
  cache.set(uri, composed);
  return composed;
}

/** Appends the plugin document section to the overview text. */
function withPluginSection(text: string): string {
  const section = pluginDocumentSection(pluginDocs);
  return section === null ? text : `${text}\n${section}`;
}
