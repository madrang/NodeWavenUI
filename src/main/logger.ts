/**
 * The main-process logging bootstrap: it wraps the shared logging core with the console print
 * handler. Lines print to stdout with ANSI level colors and the "name->child" prefix of the
 * hierarchy, and the app logs to the console only. The level gate reads the `LOG_LEVEL`
 * environment variable (an `EventLevels` number or mask), then `--verbose`, then `NODE_ENV`.
 * Import this module first, so every later module log lands in the hierarchy.
 */

import { countRe, createLogHandler, createLogger, EventLevels, type Logger, type PrintFilter, type PrintEvent } from '../shared/logging.js';

/** True when the app started with `--verbose`, which unlocks the debug level. */
const verbose = process.argv.includes('--verbose');

/** The mask of the levels the console prints. */
let consoleLogLevel: number;
const rawLogLevel = Number.parseInt(process.env.LOG_LEVEL ?? '', 10);
if (Number.isInteger(rawLogLevel)) {
  consoleLogLevel = rawLogLevel;
} else if (verbose) {
  consoleLogLevel = EventLevels.VERBOSE;
} else {
  consoleLogLevel = (process.env.NODE_ENV === 'production' ? EventLevels.STANDARD : EventLevels.VERBOSE);
}

/** Accepts every event; the mask of the print handler does the filtering. */
const consoleLogFilter: PrintFilter = () => true;

/** True when the console prints ANSI colors: `COLOR` forces the choice, otherwise the terminal decides. */
const useColors = process.env.COLOR ? process.env.COLOR !== 'false' : process.stdout.isTTY === true;

/** The ANSI color of one level. */
function getColor(level: number): string {
  if (!useColors) {
    return '';
  }
  switch (level) {
    case EventLevels.TRACE:
      return '\x1b[34m'; // Blue
    case EventLevels.DEBUG:
      return '\x1b[36m'; // Cyan
    case EventLevels.INFORMATIVE:
      return '\x1b[37m'; // White
    case EventLevels.NOTICE:
      return '\x1b[32m'; // Green
    case EventLevels.WARNING:
      return '\x1b[33m'; // Yellow
    case EventLevels.ERROR:
    case EventLevels.FATAL:
      return '\x1b[31m'; // Red
    case EventLevels.CRITICAL:
    case EventLevels.EMERGENCY:
      return '\x1b[35m'; // Magenta
    default:
      return '\x1b[37m'; // White
  }
}

/**
 * Shapes the arguments of one event into one console call: the level color and the logger name
 * prefix first, then the printf-style format string, then the remaining values.
 *
 * @param thisLogger The logger that received the event.
 * @param logLevel The level of the event.
 * @param args The arguments of the call. The function consumes the array.
 * @returns The arguments of the console call.
 */
function prepArgs(thisLogger: { name?: string } | null, logLevel: number, args: unknown[]): unknown[] {
  let msgIdx: number;
  const msgParts: string[] = [];
  const color = getColor(logLevel);
  if (typeof args[0] === 'string') {
    // Starts with string message
    const msg = args.shift() as string;
    if (typeof thisLogger?.name !== 'undefined' && thisLogger.name !== 'System') {
      if (useColors) {
        msgParts.push(color);
        msgParts.push(`\x1b[1m${thisLogger.name} -->\x1b[0m `);
      } else {
        msgParts.push(`${thisLogger.name} --> `);
      }
    }
    msgParts.push(msg);
    msgIdx = countRe(msg, '%[cdso]');
  } else {
    // Begins with an object. Add the missing start message.
    if (typeof thisLogger?.name !== 'undefined' && thisLogger.name !== 'System') {
      if (useColors) {
        msgParts.push(color);
        msgParts.push(`\x1b[1m${thisLogger.name}-->\x1b[0m %o`);
      } else {
        msgParts.push(`${thisLogger.name} --> %o`);
      }
    } else {
      msgParts.push('%o');
    }
    msgIdx = 1;
  }
  const arLen = args.length;
  for (let iter = msgIdx; iter < arLen; ++iter) {
    if (typeof args[iter] === 'string') {
      msgParts.push(' %s');
    } else {
      msgParts.push(' %o');
    }
  }
  args.unshift(msgParts.join(''));
  return args;
}

/** The console function of each level: the first entry at or above the event level wins. */
const consoleFnNames: Record<string, number> = {
  error: EventLevels.ERROR,
  warn: EventLevels.WARNING,
  info: EventLevels.INFORMATIVE,
  debug: EventLevels.DEBUG,
};

/** Prints one event to the console through the function of its level. */
const printEvent: PrintEvent = (thisLogger, logLevel, args) => {
  if (!Number.isInteger(logLevel) || (logLevel !== 0 && (logLevel & consoleLogLevel) === 0)) {
    return;
  }
  for (const n in consoleFnNames) {
    if ((consoleFnNames[n] ?? 0) >= logLevel) {
      console[n as 'error' | 'warn' | 'info' | 'debug']!.apply(console, prepArgs(thisLogger, logLevel, [...args]));
      break;
    }
    if (n === 'debug') {
      // Last item...

      (args.length > 0 ? console.debug : console.trace).apply(console, prepArgs(thisLogger, logLevel, [...args]));
    }
  }
};

/** The root logger of the main process. Every property access builds a child, so `log.mcp.host.warn(...)` needs no setup. */
export const log: Logger = createLogger(null, 'System', createLogHandler(printEvent, consoleLogFilter));
