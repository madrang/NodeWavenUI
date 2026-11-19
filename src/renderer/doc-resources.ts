/**
 * The harness documents of the app: markdown files under `docs/` that ship with the renderer assets.
 * Both agent surfaces serve them: the MCP host as resources, the chat agent through the `read` tool
 * with the `harness:` scheme.
 */

import type { PathRule, PathRuleMode } from '../shared/permissions.js';

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

/** The URI of the known-paths document. It carries no file: the read tool renders it from the
 * live path rules, so the list answers with the registered state of the moment. */
export const KNOWN_PATHS_URI = 'harness:///nodewavenui/known-paths.md';

/** The access meaning of each mode, for the document the agent reads. */
const PATH_MODE_MEANING: Readonly<Record<PathRuleMode, string>> = {
  allow: 'reads and writes need no request',
  'ask-write': 'reads run free, a write asks one card before its patch proposes',
  ask: 'every read and every write asks one card',
  deny: 'the agent reaches nothing on this path',
};

/**
 * Builds the known-paths document from the live rules.
 *
 * @param rules The registered path rules of the workspace.
 * @returns The document text: the whole list of registered paths with name, mode, and meaning.
 */
export function knownPathsDocument(rules: readonly PathRule[]): string {
  const lines = rules.map((rule) => {
    const name = rule.name ? `**${rule.name}** — ` : '';
    return `- ${name}\`${rule.path}\` — ${rule.mode}: ${PATH_MODE_MEANING[rule.mode]}`;
  });
  const list = lines.length > 0 ? lines.join('\n') : '- (no path is registered)';
  return [
    '# Known paths',
    '',
    'The registered paths of the workspace and the agent access each one grants. A folder covers everything below it, and the longest rule wins. A path without a rule asks one card on read, and every write proposes a patch for review whatever the path.',
    '',
    list,
    '',
  ].join('\n');
}

/** The root every built-in harness document lives under. */
const HARNESS_ROOT = 'harness:///nodewavenui';

/**
 * Lists one harness folder: every document under it, and every subfolder of it, one line each.
 * The built-in root answers with the shipped documents, the dynamic known-paths document, and
 * the documents of the loaded plugins. A subfolder answers the same way, so a plugin tree stays
 * walkable.
 *
 * @param uri The folder URI, with or without its trailing slash.
 * @returns The listing text, or null when the URI names no folder of the harness tree.
 */
export function harnessFolderListing(uri: string): string | null {
  if (!uri.startsWith(`${HARNESS_ROOT}/`) && uri !== HARNESS_ROOT) {
    return null;
  }
  const folder = uri.endsWith('/') ? uri : `${uri}/`;
  const under = folder.slice(HARNESS_ROOT.length + 1);
  const entries = [
    ...listHarnessDocs().map((doc) => ({ uri: doc.uri, description: doc.description })),
    { uri: KNOWN_PATHS_URI, description: 'The registered path rules with their names and modes, rendered live' },
  ];
  const files: string[] = [];
  const folders = new Set<string>();
  for (const entry of entries) {
    if (!entry.uri.startsWith(`${HARNESS_ROOT}/`)) {
      continue;
    }
    const rest = entry.uri.slice(HARNESS_ROOT.length + 1);
    if (!rest.startsWith(under)) {
      continue;
    }
    const tail = rest.slice(under.length);
    const slash = tail.indexOf('/');
    if (slash >= 0) {
      folders.add(`${tail.slice(0, slash)}/`);
    } else if (tail.length > 0) {
      files.push(`- ${tail} — ${entry.description}`);
    }
  }
  if (under.length > 0 && files.length === 0 && folders.size === 0) {
    return null;
  }
  const lines = [`# ${folder}`, '', ...files, ...[...folders].sort().map((name) => `- ${name}`)];
  if (folders.size > 0) {
    lines.push('', 'A subfolder lists the same way: read its URI with the trailing slash.');
  }
  return `${lines.join('\n')}\n`;
}

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
  if (cached) {
    return cached;
  }
  const doc = [...DOCS, ...pluginDocs].find((candidate) => candidate.uri === uri);
  if (!doc) {
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
  return section ? `${text}\n${section}` : text;
}
