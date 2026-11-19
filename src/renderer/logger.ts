/**
 * The renderer logging bootstrap: it wraps the shared logging core with the console print
 * handler. Lines print with one `%c` color badge per level and the "name->child" prefix of the
 * hierarchy; the main process relays them through its console-message hook. The level gate
 * reads the `app-log-level` local storage key (an `EventLevels` number or mask), and defaults
 * to STANDARD.
 */

import { countRe, createLogHandler, createLogger, EventLevels, type Logger, type PrintFilter, type PrintEvent } from '../shared/logging.js';

/** The local storage key that overrides the printed levels, so a session can turn on debugging. */
export const LOG_LEVEL_MIRROR_KEY = 'app-log-level';

/** The mask of the levels the console prints. */
let consoleLogLevel: number = EventLevels.STANDARD;
{
  const stored = Number.parseInt(localStorage.getItem(LOG_LEVEL_MIRROR_KEY) ?? '', 10);
  if (Number.isInteger(stored)) {
    consoleLogLevel = stored;
  }
}

/** Accepts every event; the mask of the print handler does the filtering. */
const consoleLogFilter: PrintFilter = () => true;

/** The CSS color of one level. */
function getColor(level: number): string {
  switch (level) {
    case EventLevels.TRACE:
      return 'RoyalBlue';
    case EventLevels.DEBUG:
      return 'SeaGreen';
    case EventLevels.INFORMATIVE:
      return 'Gray';
    case EventLevels.NOTICE:
      return 'LimeGreen';
    case EventLevels.WARNING:
      return 'Gold';
    case EventLevels.ERROR:
      return 'Orangered';
    case EventLevels.FATAL:
      return 'Crimson';
    case EventLevels.CRITICAL:
      return 'MediumVioletRed';
    case EventLevels.EMERGENCY:
      return 'DeepPink';
    default:
      return 'Gray';
  }
}

/**
 * Joins one style record into one `%c` style string.
 *
 * @param cssStyle The style record.
 * @returns The style string of the record.
 */
function printCss(cssStyle: Record<string, unknown>): string {
  return Object.keys(cssStyle).map((csKey) => `${csKey}:${String(cssStyle[csKey])}`).join(';');
}

/**
 * Shapes the arguments of one event into one styled console call: the level badge and the
 * logger name prefix first, then the printf-style format string, then the remaining values.
 *
 * @param thisLogger The logger that received the event.
 * @param logLevel The level of the event.
 * @param logFn The console function of the level.
 * @param args The arguments of the call. The function consumes the array.
 */
function applyLogFn(
  thisLogger: { name?: string } | null,
  logLevel: number,
  logFn: (...data: unknown[]) => void,
  args: unknown[],
): void {
  let msgIdx: number;
  const msgParts: string[] = [];
  const color = getColor(logLevel);
  const cssStyle = printCss({ color });
  const preTab = `color: black; background-color: ${color}; padding: 2px 6px; border-radius: 2px; font-size:10px`;
  if (typeof args[0] === 'string') {
    // Starts with string message
    const msg = args.shift() as string;
    if (typeof thisLogger?.name !== 'undefined' && thisLogger.name !== 'System') {
      msgParts.push(`%c${thisLogger.name} %c `);
      msgParts.push(msg);
      args.unshift(preTab, cssStyle);
      msgIdx = 2;
    } else {
      msgParts.push('%c');
      msgParts.push(msg);
      args.unshift(cssStyle);
      msgIdx = 1;
    }
    msgIdx += countRe(msg, '%[cdso]');
  } else if (typeof thisLogger?.name !== 'undefined' && thisLogger.name !== 'System') {
    // Begins with an object. Add the missing start message.
    msgParts.push(`%c${thisLogger.name} %c$o`);
    args.unshift(preTab, cssStyle);
    msgIdx = 3;
  } else {
    // Begins with an object. Add the missing start message.
    msgParts.push('%c%o');
    args.unshift(cssStyle);
    msgIdx = 2;
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
  logFn.apply(console, args);
}

/** Prints one event to the console through the function of its level. */
const printEvent: PrintEvent = (thisLogger, logLevel, args) => {
  if (!Number.isInteger(logLevel) || (logLevel !== 0 && (logLevel & consoleLogLevel) === 0)) {
    return;
  }
  if (logLevel <= EventLevels.ERROR) {
    console.error(...args);
  } else if (logLevel <= EventLevels.WARNING) {
    console.warn(...args);
  } else {
    const fnName = (logLevel <= EventLevels.INFORMATIVE ? 'info' : 'debug');
    applyLogFn(thisLogger, logLevel, console[fnName], [...args]);
  }
};

/** The root logger of the renderer. Every property access builds a child, so `log.settings.warn(...)` needs no setup. */
export const log: Logger = createLogger(null, 'System', createLogHandler(printEvent, consoleLogFilter));
