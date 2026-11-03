/**
 * The built-in system prompt sources offered in the chat menu.
 * The default source joins the harness AGENTS.md document with the AGENTS.md file of the workspace.
 */

import type { PluginRegistry, SystemPromptContext, SystemPromptSetup } from '../plugins.js';
import { readHarnessDoc } from './doc-resources.js';
import { joinPath, readTextFile } from './file-system.js';

/** The id of the source a fresh chat menu starts on. */
export const DEFAULT_SYSTEM_PROMPT_SETUP_ID = 'agents-md';

/** The id of the source that binds no system prompt. */
export const NONE_SYSTEM_PROMPT_SETUP_ID = 'none';

const AGENTS_HARNESS_URI = 'harness:///nodewavenui/AGENTS.md';
const WORKSPACE_AGENTS_FILE = 'AGENTS.md';

/**
 * Builds the default prompt: the harness instructions first, then the workspace rules.
 * A missing workspace file leaves a note in its place.
 *
 * @param context The workspace facts of the chat.
 * @returns The prompt text.
 */
async function buildAgentsPrompt(context: SystemPromptContext): Promise<string> {
  const harness = await readHarnessDoc(AGENTS_HARNESS_URI);
  const workspaceDoc = readTextFile(joinPath(context.workspacePath, WORKSPACE_AGENTS_FILE));
  if (workspaceDoc === null) {
    return `${harness}\n\nThe workspace directory holds no ${WORKSPACE_AGENTS_FILE} file.\n`;
  }
  return `${harness}\n\n# ${WORKSPACE_AGENTS_FILE} of the workspace\n\n${workspaceDoc}\n`;
}

/**
 * Registers the built-in system prompt sources on one registry.
 *
 * @param registry The plugin registry of the app.
 */
export function registerBuiltinSystemPromptSetups(registry: PluginRegistry): void {
  registry.registerSystemPromptSetup({
    id: DEFAULT_SYSTEM_PROMPT_SETUP_ID,
    label: 'AGENTS.md',
    build: buildAgentsPrompt,
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
export function defaultSystemPromptSetup(sources: readonly SystemPromptSetup[]): SystemPromptSetup | null {
  return sources.find((source) => source.id === DEFAULT_SYSTEM_PROMPT_SETUP_ID) ?? sources[0] ?? null;
}
