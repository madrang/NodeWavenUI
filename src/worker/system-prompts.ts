/**
 * The system prompt sources of the chat engine: the built-in sources of the shared contract, plus the
 * prompt files of the instructions folder of the workspace, read through the fs of the worker core.
 * The chat menu of the workspace page offers the same sources, and a send names the ones it binds
 * by id.
 */

import {
  listPromptFileSources,
  registerBuiltinSystemPromptSources,
  type SystemPromptSource,
} from '../shared/system-prompts.js';
import { joinPath, listDirectoryNames, readTextFile, statPath } from './node-file-system.js';

/** Reads the registered system prompt sources the engine binds, in menu order. */
export function workerSystemPromptSources(): readonly SystemPromptSource[] {
  const sources: SystemPromptSource[] = [];
  registerBuiltinSystemPromptSources({
    registerSystemPromptSetup: (setup) => {
      sources.push(setup);
    },
  });
  return sources;
}

/**
 * Builds the lister of the prompt files of the instructions folder of one workspace. The engine calls
 * it on every bind and on every list, so a file the folder gained or lost shows at once.
 *
 * @param workspacePath The absolute path of the workspace directory.
 * @returns The lister, one source per file of the folder, in name order.
 */
export function workerPromptFileLister(workspacePath: string): () => Promise<readonly SystemPromptSource[]> {
  return () => listPromptFileSources(workspacePath, { joinPath, listDirectoryNames, readTextFile, statPath });
}
