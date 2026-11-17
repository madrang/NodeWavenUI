/**
 * The definitions of the command tools: name, description, and input schema of every tool that
 * runs system commands and tracks their processes. The main process attaches the handlers
 * (`src/main/command-service.ts`), and both surfaces serve the same list, like the page tools.
 */

import type { WindowToolDefinition } from './window-tools.js';

/** Every command tool of the app. */
export const COMMAND_TOOL_DEFINITIONS: readonly WindowToolDefinition[] = [
  {
    name: 'run',
    description:
      'Runs one command through the system shell and answers stdout, stderr, and the exit code. A relative cwd joins the workspace root, and the default cwd is the workspace root. The shell runs the command as given: parse nothing, trust no rewritten form. The permission gate asks one card that shows the parsed stages of the command. With background true the command answers its process id at once and keeps running: read it with process_output and stop it with process_stop.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line the shell runs.' },
        cwd: { type: 'string', description: 'The working directory of the command. Default the workspace root.' },
        timeoutMs: { type: 'integer', default: 120000, description: 'The foreground cap, in milliseconds. Default 120000.' },
        background: { type: 'boolean', default: false, description: 'True to answer the process id at once and keep running.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_output',
    description:
      'Reads the captured output of one background process, from its start or since the last read. With waitMs it blocks until more output arrives or the wait ends. A process that exited answers its remaining output with its exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'integer', description: 'The id the run call answered.' },
        waitMs: { type: 'integer', default: 0, description: 'How long to wait for more output when none sits captured. Default 0.' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_stop',
    description: 'Stops one background process. Its captured output stays readable until it is drained.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'integer', description: 'The id the run call answered.' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
  },
];
