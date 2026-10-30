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
];

/** The MIME type of every harness document. */
export const HARNESS_DOC_MIME_TYPE = 'text/markdown';

const cache = new Map<string, string>();

/** One resource entry as the MCP resources/list answer carries it. */
export interface HarnessDocInfo {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** Lists the harness documents. */
export function listHarnessDocs(): readonly HarnessDocInfo[] {
  return DOCS.map((doc) => ({
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
  const doc = DOCS.find((candidate) => candidate.uri === uri);
  if (doc === undefined) {
    const list = DOCS.map((candidate) => candidate.uri).join(', ');
    throw new Error(`No harness document matches ${uri}. Valid: ${list}.`);
  }
  const response = await fetch(doc.file);
  if (!response.ok) {
    throw new Error(`The harness document ${doc.file} answered HTTP ${response.status}.`);
  }
  const text = await response.text();
  cache.set(uri, text);
  return text;
}
