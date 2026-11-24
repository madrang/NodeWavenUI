/**
 * The built-in system prompt sources of the chat menu, platform free. The default source joins the
 * harness AGENTS.md document with the AGENTS.md file of the workspace. The workspace page registers
 * the sources for the chat menu, and the worker core registers them for the chat engine that binds
 * the prompt of a chat; each side reads the workspace file through the fs of its own context.
 */

import { readHarnessDoc } from './harness-docs.js';

/** The id of the source a fresh chat menu starts on. */
export const DEFAULT_SYSTEM_PROMPT_SETUP_ID = 'agents-md';

/** The id of the source that binds no system prompt. */
export const NONE_SYSTEM_PROMPT_SETUP_ID = 'none';

const AGENTS_HARNESS_URI = 'harness:///nodewavenui/AGENTS.md';
const WORKSPACE_AGENTS_FILE = 'AGENTS.md';

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
 * Builds the default prompt: the harness instructions first, then the workspace rules.
 * A missing workspace file leaves a note in its place.
 *
 * @param context The workspace facts of the chat.
 * @param readWorkspaceFile Reads one file of the workspace. Null when the file does not read.
 * @returns The prompt text.
 */
export async function buildAgentsPrompt(
  context: SystemPromptContext,
  readWorkspaceFile: (path: string) => Promise<string | null>,
): Promise<string> {
  const harness = await readHarnessDoc(AGENTS_HARNESS_URI);
  const workspaceDocPath = `${context.workspacePath.replace(/[\\/]+$/, '')}/${WORKSPACE_AGENTS_FILE}`;
  const workspaceDoc = await readWorkspaceFile(workspaceDocPath);
  // eslint-disable-next-line local/prefer-truthiness -- an empty AGENTS.md is present, only a failed read counts as absent
  if (workspaceDoc === null) {
    return `${harness}\n\nThe workspace directory holds no ${WORKSPACE_AGENTS_FILE} file.\n`;
  }
  return `${harness}\n\n# ${WORKSPACE_AGENTS_FILE} of the workspace\n\n${workspaceDoc}\n`;
}

/**
 * Registers the built-in system prompt sources on one registry.
 *
 * @param registry The registry of the chat menu or of the chat engine.
 * @param readWorkspaceFile Reads one file of the workspace, through the fs of the running context.
 */
export function registerBuiltinSystemPromptSources(
  registry: SystemPromptRegistry,
  readWorkspaceFile: (path: string) => Promise<string | null>,
): void {
  registry.registerSystemPromptSetup({
    id: DEFAULT_SYSTEM_PROMPT_SETUP_ID,
    label: 'AGENTS.md',
    build: (context) => buildAgentsPrompt(context, readWorkspaceFile),
  });
  registry.registerSystemPromptSetup({
    id: NONE_SYSTEM_PROMPT_SETUP_ID,
    label: 'No system prompt',
    build: async () => '',
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
