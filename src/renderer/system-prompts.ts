/**
 * The system prompt sources offered in the chat menu of the workspace page.
 * The built-in sources live with the shared contract (`src/shared/system-prompts.ts`), and the prompt
 * files of the instructions folder of the workspace join them through the bridge fs. The worker core
 * lists the same files for the chat engine, so a chat binds the prompt its menu offered.
 */

import type { PluginRegistry, SystemPromptSetup } from './plugins.js';
import { listPromptFileSources, registerBuiltinSystemPromptSources } from '../shared/system-prompts.js';
import { joinPath, listDirectoryNames, readTextFile, statPath } from './file-system.js';

export { NONE_SYSTEM_PROMPT_SETUP_ID } from '../shared/system-prompts.js';

/**
 * Registers the built-in system prompt sources on one registry.
 *
 * @param registry The plugin registry of the app.
 */
export function registerBuiltinSystemPromptSetups(registry: PluginRegistry): void {
  registerBuiltinSystemPromptSources(registry);
}

/**
 * Lists the prompt files of the instructions folder of one workspace as sources of the chat menu.
 *
 * @param workspacePath The absolute path of the workspace directory.
 * @returns The sources, one per file, in name order.
 */
export function listWorkspacePromptFiles(workspacePath: string): Promise<readonly SystemPromptSetup[]> {
  return listPromptFileSources(workspacePath, { joinPath, listDirectoryNames, readTextFile, statPath });
}
