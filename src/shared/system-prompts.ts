/**
 * The system prompt sources of the chat menu, platform free. The built-in source is the harness
 * AGENTS.md document, and every file of the instructions folder of the workspace is one more source.
 * The workspace page registers the sources for the chat menu, and the worker core
 * registers them for the chat engine that binds the prompt of a chat; each side reads the folder
 * through the fs of its own context. The menu helpers shape the selectors of both surfaces, and the
 * pick helpers read what a send binds.
 */

import { readHarnessDoc } from './harness-docs.js';

/** The id of the source a fresh chat menu starts on. */
export const DEFAULT_SYSTEM_PROMPT_SETUP_ID = 'agents-md';

/** The value of the none option of every menu selector. No source registers the id. */
export const NONE_SYSTEM_PROMPT_SETUP_ID = 'none';

const AGENTS_HARNESS_URI = 'harness:///nodewavenui/AGENTS.md';

/** The file of the workspace that holds its agent rules. It sits in the instructions folder. */
export const WORKSPACE_AGENTS_FILE = 'AGENTS.md';

/** The folder of the workspace that holds the prompt files.
 * Every file in it is one entry of the system prompt menu. */
export const WORKSPACE_INSTRUCTIONS_FOLDER = 'instructions';

/** The prefix of the id of one prompt file. It keeps a file name apart from the id of a registered source. */
const PROMPT_FILE_ID_PREFIX = 'prompt-file:';

/** The facts of the workspace one prompt builds from. */
export interface SystemPromptContext {
  /** The absolute path of the workspace directory. */
  readonly workspacePath: string;
}

/** One system prompt source: an entry in the chat menu and a way to build its text. */
export interface SystemPromptSource {
  /** Unique identifier of the source, kept with the chat that binds it. */
  readonly id: string;
  /** Label shown in the chat menu and as the title of the collapsed prompt. */
  readonly label: string;
  /**
   * Builds the prompt text of one chat.
   *
   * @param context The workspace facts of the chat.
   * @returns The prompt text. An empty text binds no system message.
   */
  readonly build: (context: SystemPromptContext) => Promise<string>;
}

/** The registry surface the built-in sources register on. */
export interface SystemPromptRegistry {
  /** Registers one system prompt source. */
  registerSystemPromptSetup(setup: SystemPromptSource): void;
}

/**
 * Registers the built-in system prompt source on one registry: the harness AGENTS.md document.
 *
 * @param registry The registry of the chat menu or of the chat engine.
 */
export function registerBuiltinSystemPromptSources(registry: SystemPromptRegistry): void {
  registry.registerSystemPromptSetup({
    id: DEFAULT_SYSTEM_PROMPT_SETUP_ID,
    label: 'AGENTS.md (built-in)',
    build: async () => readHarnessDoc(AGENTS_HARNESS_URI),
  });
}

/**
 * Reads the source a fresh chat menu starts on.
 *
 * @param sources The registered sources.
 * @returns The default source, or null when nothing registered.
 */
export function defaultSystemPromptSetup<T extends { readonly id: string }>(sources: readonly T[]): T | null {
  return sources.find((source) => source.id === DEFAULT_SYSTEM_PROMPT_SETUP_ID) ?? sources[0] ?? null;
}

/**
 * Reads the source ids a fresh chat menu starts on: the default source, or none when nothing registers.
 *
 * @param sources Every source the menu or the engine holds. A source of the none id is never a default.
 * @returns The ids, in concatenation order. Empty for the none prompt.
 */
export function defaultSystemPromptIds(sources: readonly { readonly id: string }[]): readonly string[] {
  const source = defaultSystemPromptSetup(sources);
  return source && source.id !== NONE_SYSTEM_PROMPT_SETUP_ID ? [source.id] : [];
}

/** The fs slice the prompt sources reach the workspace through. The renderer fs module and the worker
 * fs module both satisfy it (`src/renderer/file-system.ts`, `src/worker/node-file-system.ts`). */
export interface SystemPromptFs {
  joinPath(directory: string, file: string): string;
  listDirectoryNames(directory: string): Promise<readonly string[] | null>;
  readTextFile(path: string): Promise<string | null>;
  statPath(path: string): Promise<{ directory: boolean } | null>;
}

/** The fs slice that moves one file of the workspace. */
export interface SystemPromptMoveFs {
  joinPath(directory: string, file: string): string;
  statPath(path: string): Promise<{ directory: boolean } | null>;
  makeDirectory(path: string): Promise<void>;
  renamePath(from: string, to: string): Promise<void>;
}

/** Reads the id of one prompt file of the instructions folder. */
export function promptFileId(fileName: string): string {
  return `${PROMPT_FILE_ID_PREFIX}${fileName}`;
}

/**
 * Lists the prompt files of the instructions folder of one workspace as prompt sources, in name order.
 * A missing or unreadable folder lists nothing. A subfolder and a hidden file, with a name that starts
 * with a dot, list nothing. The build of a file that fails to read throws, so the send explains the loss.
 *
 * @param workspacePath The absolute path of the workspace directory.
 * @param fs The fs slice of the running context.
 * @returns The sources, one per file.
 */
export async function listPromptFileSources(
  workspacePath: string,
  fs: SystemPromptFs,
): Promise<SystemPromptSource[]> {
  const folder = fs.joinPath(workspacePath, WORKSPACE_INSTRUCTIONS_FOLDER);
  const names = await fs.listDirectoryNames(folder);
  if (!names) {
    return [];
  }
  const sources: SystemPromptSource[] = [];
  for (const name of [...names].sort()) {
    // An editor leaves its lock and swap files in the folder, with a name that starts with a dot.
    if (name.startsWith('.')) {
      continue;
    }
    const path = fs.joinPath(folder, name);
    const stat = await fs.statPath(path);
    if (!stat || stat.directory) {
      continue;
    }
    sources.push({
      id: promptFileId(name),
      label: name,
      build: async () => {
        const text = await fs.readTextFile(path);
        // eslint-disable-next-line local/prefer-truthiness -- an empty file is a real read, only a failed read counts as lost
        if (text === null) {
          throw new Error(`The file "${path}" does not read.`);
        }
        return text;
      },
    });
  }
  return sources;
}

/** How the move of the workspace AGENTS.md file went. */
export type AgentsFileMove = 'moved' | 'absent' | 'kept';

/**
 * Moves the AGENTS.md file of the workspace root into the instructions folder, where the system prompt
 * menu lists it with the other prompt files. A root without the file moves nothing. A file that sits at
 * the target already keeps its place, and the root file stays too: nothing overwrites a file.
 *
 * @param workspacePath The absolute path of the workspace directory.
 * @param fs The fs slice of the running context.
 * @returns How the move went.
 */
export async function moveWorkspaceAgentsFile(workspacePath: string, fs: SystemPromptMoveFs): Promise<AgentsFileMove> {
  const rootFile = fs.joinPath(workspacePath, WORKSPACE_AGENTS_FILE);
  const root = await fs.statPath(rootFile);
  if (!root || root.directory) {
    return 'absent';
  }
  const folder = fs.joinPath(workspacePath, WORKSPACE_INSTRUCTIONS_FOLDER);
  const target = fs.joinPath(folder, WORKSPACE_AGENTS_FILE);
  if (await fs.statPath(target)) {
    return 'kept';
  }
  await fs.makeDirectory(folder);
  await fs.renamePath(rootFile, target);
  return 'moved';
}

/**
 * Joins the texts of several prompt sources into one system prompt: a blank line between two texts,
 * and an empty text adds nothing.
 *
 * @param texts The built texts, in concatenation order.
 * @returns The prompt text. Empty when every text is empty.
 */
export function joinSystemPromptTexts(texts: readonly string[]): string {
  return texts
    .map((text) => text.replace(/\s+$/, ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * Reads the sources a first send binds. The known ids keep the order of the pick, and an id that names
 * no source drops out. An empty pick binds the none prompt. No pick, or a pick that names no known
 * source, reads as the default source.
 *
 * @param picked The source ids the menu holds, in concatenation order, or undefined when the sender
 * holds no menu.
 * @param sources Every source the engine binds.
 * @returns The sources to bind, in concatenation order. Empty for the none prompt.
 */
export function resolveSystemPromptSources<T extends { readonly id: string }>(
  picked: readonly string[] | undefined,
  sources: readonly T[],
): T[] {
  const byId = new Map(sources.map((source) => [source.id, source] as const));
  const sourcesOf = (ids: readonly string[]): T[] =>
    ids.flatMap((id, index) => (byId.has(id) && ids.indexOf(id) === index ? byId.get(id) ?? [] : []));
  if (picked && (picked.length === 0 || picked.some((id) => byId.has(id)))) {
    return sourcesOf(picked);
  }
  // A pick that names no known source reads as no pick.
  return sourcesOf(defaultSystemPromptIds(sources));
}

/**
 * Reads the system prompt pick of one send. An empty list is the none pick, and it stays. A value of
 * another shape, or a list that holds no string, reads as no pick.
 *
 * @param value The `systemPromptIds` of one send. It can have any type.
 * @returns The ids, in the order of the pick, or undefined for no pick.
 */
export function readSystemPromptIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.filter((id): id is string => typeof id === 'string');
  return value.length > 0 && ids.length === 0 ? undefined : ids;
}

/** One selector of the system prompt menu. */
export interface PromptSelectorSlot<T> {
  /** The position of the selector in the menu, from zero. The order of the slots is the concatenation order. */
  readonly slot: number;
  /** The source the selector holds. Null while it stands on none. */
  readonly selectedId: string | null;
  /** The sources the selector offers: every source no selector holds. */
  readonly choices: readonly T[];
}

/** The selectors of one system prompt menu and the selection they hold. */
export interface PromptSelectorSet<T> {
  /** The selected sources in concatenation order: the selection without the ids that name no source. */
  readonly selected: readonly string[];
  readonly slots: readonly PromptSelectorSlot<T>[];
}

/**
 * Shapes the selectors of one system prompt menu. The menu holds one selector per selected source, in
 * the order of the selection, and one more while a source stays unselected. A selector offers the
 * sources no other selector holds. A selected id that names no source drops out.
 *
 * @param sources The sources the menu lists, without the none source.
 * @param selected The source ids the menu holds, in concatenation order.
 * @returns The selection and its slots. No slot answers while the menu lists no source.
 */
export function resolvePromptSelectors<T extends { readonly id: string }>(
  sources: readonly T[],
  selected: readonly string[],
): PromptSelectorSet<T> {
  const taken: string[] = [];
  for (const id of selected) {
    if (sources.some((source) => source.id === id) && !taken.includes(id)) {
      taken.push(id);
    }
  }
  const slots: PromptSelectorSlot<T>[] = taken.map((id, slot) => ({
    slot,
    selectedId: id,
    choices: sources.filter((source) => source.id === id || !taken.includes(source.id)),
  }));
  const unselected = sources.filter((source) => !taken.includes(source.id));
  if (unselected.length > 0) {
    slots.push({ slot: taken.length, selectedId: null, choices: unselected });
  }
  return { selected: taken, slots };
}

/**
 * Applies one change of a menu selector to the selection of its menu. A source takes its slot, and the
 * selection goes on from there. None ends the selection at its slot.
 *
 * @param selected The selection the slots of the menu hold.
 * @param slot The position of the selector that changed.
 * @param id The source the selector holds now, or null for none.
 * @returns The next selection.
 */
export function withPromptSelectorChange(selected: readonly string[], slot: number, id: string | null): string[] {
  const next = selected.slice(0, slot);
  if (id) {
    next.push(id);
  }
  return next;
}
