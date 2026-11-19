/**
 * The logging core of the app.
 * It is platform free: the main process and the sandboxed renderers import the same compiled
 * module and wrap it with their own print handlers. A logger is a Proxy: every property access
 * builds (or fetches from a WeakMap) a child logger, so `log.mcp.host.warn(...)` walks down a
 * named hierarchy without any setup. Keep this file free of platform dependencies, so that every
 * module can import it.
 */

/** One event level or level mask of the logging system. The levels are single bits, so a mask ORs them. */
export const EventLevels = Object.freeze({
  // System is in a situation that poses an immediate risk,
  // require urgent intervention to prevent a worsening of the situation.
  EMERGENCY: 0,

  // An error of sufficient magnitude that the system aborted all operations to protect itself.
  FATAL: 1 << 0,

  // An error of sufficient magnitude that it cannot be handled.
  // Should be corrected immediately. Impact system operations.
  CRITICAL: 1 << 1,

  // An error that prevents an operation from completing successfully,
  // Could be handled without affecting the system continued operation.
  // Should be corrected immediately, but the failure is in a secondary system. System remains functional.
  ERROR: 1 << 2,

  // Indication that an error will occur if no action is taken.
  WARNING: 1 << 3,

  // Events that are unusual but not error conditions.
  NOTICE: 1 << 4,

  // Normal operational messages.
  INFORMATIVE: 1 << 5,

  // Debug information that will only need to be seen when tracking down specific problems.
  DEBUG: 1 << 6,

  // Spam box, whatever info that could be useful when tracking a specific problem.
  TRACE: 1 << 7,

  // All messages will be logged.
  ALL: 0xff,

  // Minimal logging, errors and warnings only.
  MINIMUM: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3),

  // Standard messages will be logged.
  STANDARD: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5),

  // Verbose, standard, and debugging. Does not include trace.
  VERBOSE: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6),
} as const);

/** One logger instance: the name plus the per-level methods the handler constructor adds. */
interface LoggerInstance {
  name: string;
  [key: string]: unknown;
  [key: symbol]: unknown;
}

/** Constructs logger instances. `createLogHandler` builds one from a print pair. */
export interface LogConstructor {
  new (name: string): LoggerInstance;
}

/** Prints one accepted event. The bootstrap of each platform provides the implementation. */
export type PrintEvent = (logger: LoggerInstance, logLevel: number, args: unknown[]) => void;

/** Returns false to suppress one event before it prints. */
export type PrintFilter = (logger: LoggerInstance, logLevel: number, args: unknown[]) => boolean;

/**
 * A logger of the hierarchy. The core methods print at one level; every other property access
 * returns a child logger, so any path of names builds the hierarchy without setup.
 */
export type Logger = {
  readonly name: string;
  emergency(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  critical(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warning(...args: unknown[]): void;
  notice(...args: unknown[]): void;
  informative(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  /** Alias of `informative`. */
  info(...args: unknown[]): void;
  /** Alias of `warning`. */
  warn(...args: unknown[]): void;
  /** Prints one event at an explicit level or mask bit, bypassing the filter. */
  print(logLevel: number, args: unknown[]): void;
  getCtor(): LogConstructor;
} & { [key in string & {}]: Logger };

/**
 * Builds the logger constructor of one print pair: `printFilter` gates every event, then
 * `printEvent` renders it. The constructor carries one method per `EventLevels` entry.
 *
 * @param printEvent Renders one accepted event.
 * @param printFilter Returns false to suppress one event.
 * @returns The constructor the root logger and every child build with.
 * @throws Error when either argument is not a function.
 */
export function createLogHandler(printEvent: PrintEvent, printFilter: PrintFilter): LogConstructor {
  if (typeof printEvent !== 'function') {
    throw new Error('printEvent is not a function.');
  }
  if (typeof printFilter !== 'function') {
    throw new Error('printFilter is not a function.');
  }
  const LogBase = function LogBase(this: LoggerInstance, name: string): void {
    if (typeof name === 'undefined') {
      throw new Error('Name is undefined.');
    } else if (typeof name === 'string') {
      this.name = name;
    } else {
      throw new Error('Name is not a string.');
    }
  } as unknown as LogConstructor;
  const prototype = LogBase.prototype as unknown as Record<string, unknown>;
  prototype.getCtor = (): LogConstructor => LogBase;
  // Add one log function per level, plus the aliases and the raw print.
  for (const levelName in EventLevels) {
    const logLvl = EventLevels[levelName as keyof typeof EventLevels];
    prototype[levelName.toLowerCase()] = function logFunction(this: LoggerInstance, ...args: unknown[]): void {
      if (!printFilter(this, logLvl, args)) {
        return;
      }
      printEvent(this, logLvl, args);
    };
  }
  prototype.info = prototype.informative;
  prototype.warn = prototype.warning;
  prototype.print = function print(this: LoggerInstance, logLvl: number, args: unknown[]): void {
    printEvent(this, logLvl, args);
  };
  return LogBase;
}

/** Marks the per-logger WeakMap that caches the child loggers of object keys. */
const SYMBOL_WEAK_MAP = Symbol('WeakLogMap');

const proxyHandler: ProxyHandler<LoggerInstance> = Object.create(null) as ProxyHandler<LoggerInstance>;
proxyHandler.set = (target, propertyKey, value, receiver): boolean => Reflect.set(target, propertyKey, value, receiver);

/**
 * Builds one logger of the hierarchy. The name of a child joins the name of its parent with
 * "->", and the root name "System" stays invisible, so `log.mcp.host` prints as "System->mcp->host".
 *
 * @param parent The parent logger, or null for the root.
 * @param name The name of the new logger.
 * @param loggerCtor The constructor of the platform. Falls back to the constructor of the parent.
 * @returns The new logger, wrapped in the hierarchy proxy.
 * @throws Error when the name is missing or no constructor resolves.
 */
export function createLogger(parent: LoggerInstance | null, name: string, loggerCtor?: LogConstructor): Logger {
  if (typeof name !== 'string') {
    throw new Error('name is not a string.');
  }
  let newLoggerName: string;
  if (parent && typeof parent.name === 'string' && parent.name !== 'System') {
    newLoggerName = [parent.name, '->', name].join('');
  } else {
    // No parent, or the invisible root.
    newLoggerName = name;
  }
  let ctor = loggerCtor;
  if (typeof ctor !== 'function') {
    const parentCtor = (parent as (LoggerInstance & { getCtor?: () => LogConstructor }) | null)?.getCtor;
    if (typeof parentCtor === 'function') {
      ctor = parentCtor();
      if (typeof ctor !== 'function') {
        throw new Error('parent.getCtor did not return a function.');
      }
    } else if (parent) {
      throw new Error('parent.createLogger is not a function.');
    } else {
      throw new Error('Without a parent, loggerCtor is required to be a function.');
    }
  }
  return new Proxy(new ctor(newLoggerName), proxyHandler) as unknown as Logger;
}

proxyHandler.get = (target, propertyKey): unknown => {
  if (propertyKey in target) {
    return Reflect.get(target, propertyKey);
  }
  const propType = typeof propertyKey as string;
  if (propType === 'object') {
    // WeakMap keys must be objects, not primitive values. A caller reaches this branch through
    // Reflect.get with an object key; plain property access always sees strings.
    const key = propertyKey as unknown as { name?: unknown; toString?: () => string; prototype?: { name?: unknown } };
    let weakLogMap = target[SYMBOL_WEAK_MAP] as WeakMap<object, Logger> | undefined;
    if (!weakLogMap) {
      weakLogMap = new WeakMap();
      target[SYMBOL_WEAK_MAP] = weakLogMap;
    }
    if (weakLogMap.has(key)) {
      return weakLogMap.get(key);
    }
    let newLoggerName: string;
    if (typeof key.name === 'string') {
      newLoggerName = key.name;
    } else if (typeof key.toString === 'function') {
      newLoggerName = key.toString();
    } else {
      newLoggerName = String((key as { prototype: { name?: unknown } }).prototype?.name);
    }
    const newLog = createLogger(target, newLoggerName);
    weakLogMap.set(key, newLog);
    return newLog;
  }
  return createLogger(target, propertyKey as string);
};
Object.freeze(proxyHandler);

/** Flattens one Error into a plain record, so JSON.stringify reads the message getters. */
export function replaceErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    // Replace property getters by their values.
    const error: Record<string, unknown> = {};
    for (const propName of Object.getOwnPropertyNames(value)) {
      error[propName] = (value as unknown as Record<string, unknown>)[propName];
    }
    return error;
  }
  return value;
}

/**
 * Renders one argument as printable text.
 *
 * @param a The value.
 * @returns The string form: strings stay, objects stringify with errors flattened, circular structures fall back to their error text.
 */
export function valueToString(a: unknown): string {
  if (typeof a === 'undefined') {
    return 'undefined';
  } else if (typeof a === 'string') {
    return a;
  } else if (typeof (a as { toString?: unknown }).toString === 'function' && !(a instanceof Error)) {
    return String(a);
  }
  try {
    return JSON.stringify(a, replaceErrors, 4) ?? String(a);
  } catch (ex) {
    // Converting circular structure to JSON
    return String(ex);
  }
}

/**
 * Renders every argument of one event as text.
 *
 * @param args The arguments of one log call.
 * @returns The string form of each argument.
 * @throws Error when the arguments do not come as an array.
 */
export function mapArgsToString(args: unknown[]): string[] {
  if (!Array.isArray(args)) {
    throw new Error('args must be an array.');
  }
  return args.map(valueToString);
}

/**
 * Counts the matches of one regular expression in one string.
 *
 * @param str The string to scan.
 * @param re The expression, or its source text. A non-global expression turns global for the count.
 * @returns The number of matches.
 * @throws Error when the string or the expression is missing.
 */
export function countRe(str: string, re: RegExp | string): number {
  if (typeof str !== 'string') {
    throw new Error(`str need to be a string but an unexpected type of '${typeof str}' was received.`);
  }
  if (!re) {
    throw new Error('Missing Regex!');
  }
  let expression: RegExp;
  if (re instanceof RegExp) {
    expression = re.global ? re : new RegExp(re, 'gm');
  } else {
    expression = new RegExp(re, 'gm');
  }
  const reMatches = str.match(expression);
  if (!reMatches) {
    return 0;
  }
  return reMatches.length;
}
