/**
 * The command runner of the main process: the `run` tool and its process readers. The system
 * shell runs every command as given, so the app never interprets a command — the permission
 * card parses for display only. A foreground run answers stdout, stderr, and the exit code under
 * a timeout, and a background run answers its process id at once. One registry holds every
 * background process with a capped output buffer and wakes waiting readers on new output or exit.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { COMMAND_TOOL_DEFINITIONS } from '../shared/command-tool.js';
import type { McpToolResult } from '../shared/window-tools.js';
import type { McpToolDescriptor } from './mcp-host.js';
import { callWorkspace } from './workspace-link.js';

/** The caller a tool call carries, mirroring the session service shape. */
interface Caller {
  readonly principal: string;
  readonly source?: string;
  readonly preauthorized?: boolean;
}

/** The default foreground cap. */
const FOREGROUND_TIMEOUT_MS = 120000;

/** The output a process keeps, foreground answer and background buffer both. */
const OUTPUT_CAP = 65536;

/** One background process of the registry. */
interface BackgroundProcess {
  readonly proc: ChildProcess;
  output: string;
  readCursor: number;
  state: 'running' | 'exited';
  exitCode: number | null;
  readonly waiters: Set<() => void>;
}

/** The running background processes, keyed by id. */
const processes = new Map<number, BackgroundProcess>();

/** The next background process id. */
let nextProcessId = 1;

/** Kills every background process when the app quits, so none outlives its owner. */
app.on('will-quit', () => {
  for (const process_ of processes.values()) {
    process_.proc.kill('SIGKILL');
  }
  processes.clear();
});

/** Reads the shell the commands run through: bash when present, sh otherwise. */
function shellPath(): string {
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** Runs one permission check through the workspace page, like the session service does. */
async function requirePermission(caller: Caller, command: string): Promise<void> {
  const answer = await callWorkspace<{ ok: boolean; error?: string }>('permission.check', {
    principal: caller.principal,
    action: 'run',
    target: { kind: 'command', command },
    description: `command ${command}`,
    source: caller.source ?? null,
    preauthorized: caller.preauthorized === true,
  });
  if (!answer?.ok) {
    throw new Error(answer?.error ?? `Permission denied: "${caller.principal}" may not run commands.`);
  }
}

/** Trims one buffer to the output cap and keeps the cursor inside it. */
function capBuffer(buffer: { output: string; readCursor: number }): void {
  if (buffer.output.length > OUTPUT_CAP) {
    buffer.output = buffer.output.slice(buffer.output.length - OUTPUT_CAP);
    buffer.readCursor = Math.min(buffer.readCursor, buffer.output.length);
  }
}

/** Wakes every waiting reader of one process. */
function wakeWaiters(process_: BackgroundProcess): void {
  for (const waiter of process_.waiters) {
    waiter();
  }
  process_.waiters.clear();
}

/** Wraps one text as a tool result. */
function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Reads a non-empty string argument. */
function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The argument "${name}" needs a non-empty string.`);
  }
  return value;
}

/** Reads a positive integer option with a default. */
function integerOption(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Resolves the working directory of one call: an absolute path as given, a relative one from the app root. */
function resolveCwd(raw: string | undefined): string {
  if (!raw || raw.length === 0) {
    return process.cwd();
  }
  return raw.startsWith('/') ? raw : join(process.cwd(), raw);
}

/** Runs one command in the foreground: captured output, exit code, and a timeout kill. */
async function runForeground(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const proc = spawn(shellPath(), ['-c', command], { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_CAP);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_CAP);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve(`The command did not start: ${error.message}`);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const parts = [
        timedOut ? `The command hit the ${timeoutMs} ms timeout and was stopped.` : `exit code: ${code ?? 'none'}`,
      ];
      if (stdout.length > 0) {
        parts.push(`stdout:\n${stdout}`);
      }
      if (stderr.length > 0) {
        parts.push(`stderr:\n${stderr}`);
      }
      resolve(parts.join('\n'));
    });
  });
}

/** Runs one command in the background and registers its process. */
function runBackground(command: string, cwd: string): number {
  const proc = spawn(shellPath(), ['-c', command], { cwd });
  const record: BackgroundProcess = {
    proc,
    output: '',
    readCursor: 0,
    state: 'running',
    exitCode: null,
    waiters: new Set(),
  };
  const id = nextProcessId;
  nextProcessId += 1;
  processes.set(id, record);
  proc.stdout?.on('data', (chunk: Buffer) => {
    record.output += chunk.toString('utf8');
    capBuffer(record);
    wakeWaiters(record);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    record.output += chunk.toString('utf8');
    capBuffer(record);
    wakeWaiters(record);
  });
  proc.on('error', (error) => {
    record.output += `The command did not start: ${error.message}\n`;
    record.state = 'exited';
    record.exitCode = null;
    wakeWaiters(record);
  });
  proc.on('close', (code) => {
    record.state = 'exited';
    record.exitCode = code;
    wakeWaiters(record);
  });
  return id;
}

/** Reads the output of one background process since its last read, waiting when asked. */
async function readOutput(id: number, waitMs: number): Promise<string> {
  const record = processes.get(id);
  if (!record) {
    throw new Error(`The process ${id} is unknown.`);
  }
  const read = (): string => {
    const chunk = record.output.slice(record.readCursor);
    record.readCursor = record.output.length;
    // eslint-disable-next-line local/prefer-truthiness -- zero is a real exit code, only null means none
    const head = `state: ${record.state}${record.exitCode !== null ? `, exit code ${record.exitCode}` : ''}`;
    return chunk.length === 0 ? `${head}\nno new output` : `${head}\n${chunk}`;
  };
  if (record.output.length > record.readCursor || record.state === 'exited' || !waitMs) {
    return read();
  }
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      record.waiters.delete(wake);
      resolve(read());
    }, waitMs);
    const wake = (): void => {
      clearTimeout(timer);
      record.waiters.delete(wake);
      resolve(read());
    };
    record.waiters.add(wake);
  });
}

/** Builds the command tools both surfaces serve: the shared definitions with their handlers. */
export function createCommandTools(): McpToolDescriptor[] {
  const handlers: Record<string, (args: Record<string, unknown>, caller: Caller) => Promise<McpToolResult>> = {
    run: async (args, caller) => {
      const command = requireString(args, 'command');
      const cwd = resolveCwd(typeof args['cwd'] === 'string' ? args['cwd'] : undefined);
      if (!existsSync(cwd)) {
        throw new Error(`The working directory ${cwd} does not exist.`);
      }
      await requirePermission(caller, command);
      if (args['background']) {
        const id = runBackground(command, cwd);
        return textResult(`Process ${id} started in the background. Read it with process_output, stop it with process_stop.`);
      }
      const timeoutMs = integerOption(args, 'timeoutMs', FOREGROUND_TIMEOUT_MS);
      return textResult(await runForeground(command, cwd, timeoutMs));
    },
    process_output: async (args) => {
      const id = integerOption(args, 'processId', 0);
      if (id <= 0) {
        throw new Error('The argument "processId" needs a positive integer.');
      }
      const waitMs = integerOption(args, 'waitMs', 0);
      return textResult(await readOutput(id, waitMs));
    },
    process_stop: async (args) => {
      const id = integerOption(args, 'processId', 0);
      const record = processes.get(id);
      if (!record) {
        throw new Error(`The process ${id} is unknown.`);
      }
      record.proc.kill('SIGTERM');
      return textResult(`Process ${id} stopped.`);
    },
  };
  return COMMAND_TOOL_DEFINITIONS.flatMap((definition) => {
    const handler = handlers[definition.name];
    return handler ? [{ ...definition, handler }] : [];
  });
}
