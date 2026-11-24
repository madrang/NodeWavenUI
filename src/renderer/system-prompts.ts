/**
 * The built-in system prompt sources offered in the chat menu of the workspace page.
 * The sources and their builder live with the shared contract (`src/shared/system-prompts.ts`); the
 * worker core registers the same sources for the chat engine, so a chat binds the prompt its menu
 * offered.
 */

import type { PluginRegistry } from './plugins.js';
import { registerBuiltinSystemPromptSources } from '../shared/system-prompts.js';
import { readTextFile } from './file-system.js';

export {
  DEFAULT_SYSTEM_PROMPT_SETUP_ID,
  NONE_SYSTEM_PROMPT_SETUP_ID,
  defaultSystemPromptSetup,
} from '../shared/system-prompts.js';

/**
 * Registers the built-in system prompt sources on one registry.
 *
 * @param registry The plugin registry of the app.
 */
export function registerBuiltinSystemPromptSetups(registry: PluginRegistry): void {
  registerBuiltinSystemPromptSources(registry, readTextFile);
}
