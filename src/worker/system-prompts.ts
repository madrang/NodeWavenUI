/**
 * The system prompt sources of the chat engine: the built-in sources of the shared contract, read
 * through the fs of the worker core. The chat menu of the workspace page offers the same sources,
 * and a send names the one it binds by id.
 */

import { registerBuiltinSystemPromptSources, type SystemPromptSource } from '../shared/system-prompts.js';
import { readTextFile } from './node-file-system.js';

/** Reads the system prompt sources the engine binds for a first send, in menu order. */
export function workerSystemPromptSources(): readonly SystemPromptSource[] {
  const sources: SystemPromptSource[] = [];
  registerBuiltinSystemPromptSources(
    {
      registerSystemPromptSetup: (setup) => {
        sources.push(setup);
      },
    },
    readTextFile,
  );
  return sources;
}
