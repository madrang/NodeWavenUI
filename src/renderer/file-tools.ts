/**
 * The file tool set of the chat agent: `files` reads and discovers, and `write` proposes patches.
 * Reads answer from the file as this chat's pending patches leave it: the live text with the
 * rolling patch applied, so a write reads back as if it landed. Writes never touch the bridge
 * fs: every action builds one patch proposal in the patch store, and the user review owns the
 * write. A later write builds on the same virtual view, so consecutive changes stack while the
 * review waits. The read-first gate refuses a write on an existing file the agent never read in
 * the same chat: it stops agent mistakes, and it never reaches the user. Reads and writes stay
 * in separate tools, so no tool mixes the two. The naming surface of the work lives in the
 * `name` action of the `tasks` tool.
 */

import type { AgentTool, AgentToolOutput } from './agent-tools.js';
import { patchCounts, patchWaitsForReview, type PatchRecord } from './patch-store.js';
import { matchPathRule, type PathRule } from '../shared/permissions.js';
import { isWorkspaceConfigPath } from '../shared/workspace.js';
import { joinPath, listDirectoryNames, readTextFile, statPath } from './file-system.js';
import { applyPatch } from './libs/diff/index.js';

/** The patch store surface the file tools need, structural so the worker store and the page proxy both fit. */
export interface PatchProposeStore {
  propose(
    chatId: number,
    sessionFileId: string | null,
    path: string,
    oldText: string,
    proposedText: string,
  ): Promise<PatchRecord>;
  /** Reads every patch record, so the file tools lay the pending ones over the live files. */
  listPatches(): readonly PatchRecord[];
}

/** The dependencies the file tools need. */
export interface FileToolDeps {
  /** The permission check of the workspace. Reads run through it. */
  readonly check: AgentToolDepsCheck;
  /** The absolute path of the workspace directory. Every path serves inside it only. */
  readonly workspacePath: string;
  /** The numeric id of the chat whose turn runs the tool, for the read gate and the patch records. */
  readonly chatId: number;
  /** The session file id of that chat, the identity that survives restores, so the overlay and
   * the rolling patch keep their chat across a page restart. */
  readonly sessionFileId: string | null;
  /** The source the permission checks attribute their requests to. */
  readonly source: string;
  /** The patch store that holds every proposal. */
  readonly store: PatchProposeStore;
  /** Reads the known paths of the workspace, which grant or refuse access per path. */
  readonly pathRules: () => readonly PathRule[];
}

/** The permission check shape the tools need, kept local so the interface of agent-tools stays closed. */
export interface AgentToolDepsCheck {
  check(principal: 'agent', action: string, target: { kind: 'file'; path: string }, detail: string, source?: string | null): Promise<void>;
}

/** The paths each chat read through the files tool. One write on an existing path needs its read first. */
const readPaths = new Map<number, Set<string>>();

/** Reads the read set of one chat, creating it on first use. */
function readsOf(chatId: number): Set<string> {
  let set = readPaths.get(chatId);
  if (!set) {
    set = new Set();
    readPaths.set(chatId, set);
  }
  return set;
}

/** Reads one required string argument. */
function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The argument "${name}" needs a non-empty string.`);
  }
  return value;
}

/** Resolves one path argument: an absolute path stays as given, a relative one joins the workspace root. */
function resolveWorkspacePath(raw: string, workspacePath: string): string {
  const root = workspacePath.replace(/[\\/]+$/, '');
  return raw.startsWith('/') ? raw : joinPath(root, raw);
}

/** True when text holds a null byte, so it reads as binary rather than text. */
function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

/**
 * Runs the read permission of one path. A known path decides alone: deny refuses, allow and
 * ask-write read free, ask keeps the request card. A config file without a rule refuses at
 * once. Every other path without a rule asks through the pipeline.
 */
async function checkRead(deps: FileToolDeps, path: string, detail: string): Promise<void> {
  const rule = matchPathRule(deps.pathRules(), path, deps.workspacePath);
  if (rule?.mode === 'deny') {
    throw new Error(`The known path "${rule.path}" denies every agent access.`);
  }
  if (rule?.mode === 'allow' || rule?.mode === 'ask-write') {
    return;
  }
  if (!rule && isWorkspaceConfigPath(path, deps.workspacePath)) {
    throw new Error(`The path ${path} holds workspace configuration, so the agent reads it never. Add a known path rule to open it.`);
  }
  await deps.check.check('agent', 'read', { kind: 'file', path }, detail, deps.source);
}

/** True when one path refuses the agent without a request card: a deny rule, or a config file
 * without a rule. The grep walk skips these paths instead of failing the whole scan. */
function pathRefused(deps: FileToolDeps, path: string): boolean {
  const rule = matchPathRule(deps.pathRules(), path, deps.workspacePath);
  return rule?.mode === 'deny' || (!rule && isWorkspaceConfigPath(path, deps.workspacePath));
}

/**
 * Reads the pending patch record of one chat and path: the same rolling record the store
 * refreshes on a later write, newest first.
 */
function pendingPatchOf(deps: FileToolDeps, path: string): PatchRecord | null {
  return (
    deps.store
      .listPatches()
      .filter((record) => record.path === path && patchWaitsForReview(record.state))
      .filter((record) => patchBelongsToChat(record, deps.chatId, deps.sessionFileId))
      .sort((left, right) => right.id - left.id)
      .at(0) ?? null
  );
}

/** True when one pending record belongs to this chat. The session file id survives restores;
 * the runtime chat id does not. A chat without one matches on the runtime id, which holds until
 * the next restore, and a record without one matches the same way. */
function patchBelongsToChat(record: PatchRecord, chatId: number, sessionFileId: string | null): boolean {
  if (sessionFileId) {
    return record.sessionFileId === sessionFileId;
  }
  return record.chatId === chatId;
}

/**
 * Reads the names this chat proposed into one folder and the disk list holds not, so the
 * virtual files of pending patches appear beside the real ones.
 */
function pendingNamesIn(deps: FileToolDeps, folder: string, names: readonly string[]): readonly string[] {
  const base = folder.replace(/[\\/]+$/, '');
  const extra = deps.store
    .listPatches()
    .filter((record) => {
      if (record.chatId !== deps.chatId || !patchWaitsForReview(record.state)) {
        return false;
      }
      const separator = record.path.lastIndexOf('/');
      return record.path.slice(0, separator) === base && !names.includes(record.path.slice(separator + 1));
    })
    .map((record) => record.path.slice(record.path.lastIndexOf('/') + 1));
  return [...names, ...extra];
}

/**
 * Reads one file as the agent sees it: the live text with the pending patch of this chat
 * applied, so a write reads back as if it landed. The patch applies with the same fuzz band
 * the review uses, so a file that drifted answers with the conflict the review will show.
 *
 * @param deps The tool dependencies, which name the chat and the patch store.
 * @param path The absolute file path.
 * @returns The virtual text, or null when the file sits absent on disk with no pending patch.
 * @throws Error when the pending patch no longer matches the live file.
 */
async function readVirtualText(deps: FileToolDeps, path: string): Promise<string | null> {
  const record = pendingPatchOf(deps, path);
  const live = await readTextFile(path);
  if (!record) {
    return live;
  }
  const merged = applyPatch(live ?? '', record.patch, { fuzzFactor: 2 });
  // An empty string is a valid overlay of an empty result; only a non-string answer conflicts.
  if (typeof merged !== 'string') {
    throw new Error(`The pending patch for ${path} no longer matches the live file. The review will show the conflict.`);
  }
  return merged;
}

/** Builds the `files` tool: the read surface. Every action answers from the live file. */
function createFilesTool(deps: FileToolDeps): AgentTool {
  return {
    name: 'files',
    description:
      'Reads and discovers files. A relative path joins the workspace root and an absolute path reads as given. action read returns the whole file or one line range, action grep scans a regular expression over a path subtree, and action list returns one directory level. Every read answers from the file with this chat\'s pending patches applied, so a write reads back as if it landed. Every read without a known path asks one card, a known path can grant or refuse it, and the workspace config files (the marker, the settings file, the remote certificate folder) refuse until a known path rule opens them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'grep', 'list'], default: 'read', description: 'The read to run.' },
        path: { type: 'string', description: 'The file or folder path, absolute or workspace-relative.' },
        startLine: { type: 'integer', description: 'The first line of a read range, 1-based. Action read only.' },
        endLine: { type: 'integer', description: 'The last line of a read range, 1-based, inclusive. Action read only.' },
        pattern: { type: 'string', description: 'The regular expression to scan for. Action grep only.' },
        maxResults: { type: 'integer', default: 200, description: 'The cap of grep matches. The reply notes a truncated scan.' },
      },
      required: ['action', 'path'],
      additionalProperties: false,
    },
    run: async (args): Promise<AgentToolOutput> => {
      const action = args['action'] === 'grep' || args['action'] === 'list' ? args['action'] : 'read';
      const rawPath = requireString(args, 'path');
      const path = resolveWorkspacePath(rawPath, deps.workspacePath);
      if (action === 'list') {
        return { text: await runList(deps, path) };
      }
      if (action === 'grep') {
        return { text: await runGrep(deps, path, requireString(args, 'pattern'), args) };
      }
      return { text: await runRead(deps, path, args) };
    },
  };
}

/** Runs the read action: the whole file, or one line range. Records the path for the read gate. */
async function runRead(deps: FileToolDeps, path: string, args: Record<string, unknown>): Promise<string> {
  const stat = await statPath(path);
  if (stat?.directory) {
    throw new Error(`The path ${path} is a directory. Use action list for it.`);
  }
  await checkRead(deps, path, `file ${path}`);
  const text = await readVirtualText(deps, path);
  // eslint-disable-next-line local/prefer-truthiness -- an empty file reads as an empty string, only a failed read throws
  if (text === null) {
    throw new Error(`The file ${path} does not read. It may not exist.`);
  }
  readsOf(deps.chatId).add(path);
  const start = typeof args['startLine'] === 'number' && args['startLine'] >= 1 ? Math.floor(args['startLine']) : null;
  const end = typeof args['endLine'] === 'number' && args['endLine'] >= 1 ? Math.floor(args['endLine']) : null;
  if (!start && !end) {
    return text;
  }
  const lines = text.split('\n');
  const first = (start ?? 1) - 1;
  const last = Math.min(end ?? lines.length, lines.length);
  const slice = lines.slice(first, last).map((line, index) => `${first + index + 1}\t${line}`);
  return slice.join('\n');
}

/** Runs the list action: one directory level with the folder mark. A file this chat proposed
 * into the folder lists beside the disk names, so the virtual view stays whole. */
async function runList(deps: FileToolDeps, path: string): Promise<string> {
  await checkRead(deps, path, `folder ${path}`);
  const names = await listDirectoryNames(path);
  if (!names) {
    throw new Error(`The folder ${path} does not read. It may not exist.`);
  }
  const withPending = pendingNamesIn(deps, path, names);
  const pending = new Set(
    deps.store
      .listPatches()
      .filter((record) => record.chatId === deps.chatId && patchWaitsForReview(record.state))
      .map((record) => record.path),
  );
  const rows: string[] = [];
  for (const name of [...withPending].sort((left, right) => left.localeCompare(right))) {
    if (pending.has(joinPath(path.replace(/[\\/]+$/, ''), name))) {
      rows.push(name);
      continue;
    }
    const stat = await statPath(joinPath(path, name));
    rows.push(stat?.directory ? `${name}/` : name);
  }
  return rows.length === 0 ? '(the folder holds nothing)' : rows.join('\n');
}

/** Runs the grep action: a regular expression over every file of one subtree, capped. */
async function runGrep(
  deps: FileToolDeps,
  path: string,
  patternText: string,
  args: Record<string, unknown>,
): Promise<string> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternText);
  } catch (error) {
    throw new Error(`The pattern does not compile: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  await checkRead(deps, path, `grep ${path}`);
  const cap = typeof args['maxResults'] === 'number' && args['maxResults'] >= 1 ? Math.floor(args['maxResults']) : 200;
  const rows: string[] = [];
  let truncated = false;
  const walk = async (directory: string): Promise<void> => {
    if (truncated) {
      return;
    }
    const names = await listDirectoryNames(directory);
    if (!names) {
      return;
    }
    for (const name of [...pendingNamesIn(deps, directory, names)].sort((left, right) => left.localeCompare(right))) {
      if (truncated) {
        return;
      }
      const entry = joinPath(directory, name);
      if (pathRefused(deps, entry)) {
        continue;
      }
      const stat = await statPath(entry);
      if (stat?.directory) {
        await walk(entry);
        continue;
      }
      let text: string | null;
      try {
        text = await readVirtualText(deps, entry);
      } catch {
        // A pending patch that no longer matches its file stays out of the scan; the read
        // action reports the conflict when the agent targets the file.
        continue;
      }
      if (typeof text !== 'string' || looksBinary(text)) {
        continue;
      }
      for (let index = 0; index < text.length && !truncated; index += 1) {
        const lineEnd = text.indexOf('\n', index);
        const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
        if (pattern.test(line)) {
          const lineIndex = text.slice(0, index).split('\n').length;
          rows.push(`${entry}:${lineIndex}:${line}`);
          if (rows.length >= cap) {
            truncated = true;
          }
        }
        if (lineEnd === -1) {
          break;
        }
        index = lineEnd;
      }
    }
  };
  await walk(path);
  if (rows.length === 0) {
    return 'No match.';
  }
  return rows.join('\n') + (truncated ? `\n(truncated at ${cap} matches)` : '');
}

/** Builds the `write` tool: the mutation surface. Every action proposes one patch, nothing writes. */
function createWriteTool(deps: FileToolDeps): AgentTool {
  return {
    name: 'write',
    description:
      'Proposes file changes as unified diff patches that wait for the user review, so nothing lands on disk until the user approves: the review is the write permission, and no approval card blocks the turn. action write proposes the whole file text, action replace changes one exact text passage, and action insert adds text before or after a line. A relative path joins the workspace root and an absolute path serves as given. One chat works one rolling patch per task and file: a later write on the same waiting file refreshes its patch, and every change builds on the file as the pending patch leaves it, so consecutive writes stack. A write on an existing file the chat never read refuses, a known deny path refuses every write, and the workspace config files refuse until a known path rule opens them. Binary files answer with a not-implemented denial.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'replace', 'insert'], default: 'write', description: 'The change to propose.' },
        path: { type: 'string', description: 'The file path, absolute or workspace-relative.' },
        text: { type: 'string', description: 'The whole proposed file text. Action write only.' },
        oldText: { type: 'string', description: 'The exact passage to change. Action replace only.' },
        newText: { type: 'string', description: 'The replacement passage. Action replace only.' },
        all: { type: 'boolean', default: false, description: 'Replace every occurrence instead of exactly one. Action replace only.' },
        line: { type: 'integer', description: 'The 1-based line the insert anchors at. Action insert only.' },
        before: { type: 'boolean', default: false, description: 'Insert before the anchor line instead of after it. Action insert only.' },
      },
      required: ['action', 'path'],
      additionalProperties: false,
    },
    run: async (args): Promise<AgentToolOutput> => {
      const action = args['action'] === 'replace' || args['action'] === 'insert' ? args['action'] : 'write';
      const rawPath = requireString(args, 'path');
      const path = resolveWorkspacePath(rawPath, deps.workspacePath);
      const rule = matchPathRule(deps.pathRules(), path, deps.workspacePath);
      if (rule?.mode === 'deny') {
        throw new Error(`The known path "${rule.path}" denies every agent write.`);
      }
      if (!rule && isWorkspaceConfigPath(path, deps.workspacePath)) {
        throw new Error(`The path ${path} holds workspace configuration, so the agent never changes it. Add a known path rule to open it.`);
      }
      const exists = (await statPath(path)) !== null;
      if (exists && !readsOf(deps.chatId).has(path)) {
        throw new Error(
          `The chat never read ${path}. Read it with the files tool first, so the change builds on the real content. A new file needs no read.`,
        );
      }
      const diskText = exists ? await readTextFile(path) : null;
      if (typeof diskText !== 'string' && exists) {
        throw new Error(`The file ${path} does not read.`);
      }
      // The change builds on the virtual view — the live file with this chat's pending patch —
      // but the stored diff anchors on the live text, so the review applies to the real file.
      const base = (await readVirtualText(deps, path)) ?? '';
      if (looksBinary(base) || (action === 'write' && typeof args['text'] === 'string' && looksBinary(args['text']))) {
        throw new Error('Binary file editing is not implemented. The write tool serves text files only.');
      }
      let proposed: string;
      if (action === 'replace') {
        proposed = proposeReplace(base, args, path);
      } else if (action === 'insert') {
        proposed = proposeInsert(base, args);
      } else {
        proposed = proposeWhole(base, args);
      }
      if (proposed === base) {
        return { text: `No change for ${path}: the proposed text matches the file.` };
      }
      const record = await deps.store.propose(deps.chatId, deps.sessionFileId, path, diskText ?? '', proposed);
      const counts = patchCounts(record.patch);
      return {
        text: `Patch ${record.id} ${record.state === 'pending' ? 'waits' : 'updated'} for review: ${rawPath} (+${counts.added} -${counts.removed}). The user reviews it in the Events feed. Continue the task: a later write on the same file joins the same patch.`,
      };
    },
  };
}

/** Reads the proposed text of the whole-file action. */
function proposeWhole(base: string, args: Record<string, unknown>): string {
  if (typeof args['text'] !== 'string') {
    throw new Error('The action write needs a text string.');
  }
  return args['text'];
}

/** Reads the proposed text of the replace action, with the occurrence guard. */
function proposeReplace(base: string, args: Record<string, unknown>, path: string): string {
  const oldText = requireString(args, 'oldText');
  const newText = requireString(args, 'newText');
  const count = base.split(oldText).length - 1;
  if (count === 0) {
    throw new Error(`The oldText passage sits nowhere in ${path}. Read the file again and copy the passage exactly.`);
  }
  if (args['all']) {
    return base.split(oldText).join(newText);
  }
  if (count > 1) {
    throw new Error(`The oldText passage sits ${count} times in ${path}. Copy more context so it sits once, or pass all true.`);
  }
  return base.replace(oldText, newText);
}

/** Reads the proposed text of the insert action. */
function proposeInsert(base: string, args: Record<string, unknown>): string {
  if (typeof args['text'] !== 'string' || args['text'].length === 0) {
    throw new Error('The action insert needs a text string.');
  }
  if (typeof args['line'] !== 'number' || !Number.isInteger(args['line']) || args['line'] < 1) {
    throw new Error('The action insert needs a line integer of at least 1.');
  }
  const lines = base.split('\n');
  const anchor = Math.min(args['line'], lines.length);
  const at = args['before'] ? anchor - 1 : anchor;
  lines.splice(at, 0, ...args['text'].split('\n'));
  return lines.join('\n');
}

/** Builds the file tool set: the read surface and the mutation surface. */
export function createFileTools(deps: FileToolDeps): readonly AgentTool[] {
  return [createFilesTool(deps), createWriteTool(deps)];
}
