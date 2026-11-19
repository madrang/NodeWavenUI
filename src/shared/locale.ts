/**
 * The localisation core of the app.
 * It is DOM free, so the main process and the sandboxed renderers share the compiled module;
 * the DOM-bound pieces (the HTML walker, the language detection) live in the renderer locale
 * module. A message carries `${token}` placeholders: the resolver replaces each token from the
 * dictionary, then re-scans its output until it stops changing, so a value may itself contain
 * tokens. Keep this file free of platform dependencies, so that every module can import it.
 */

/** Matches every `${token}` placeholder of a message. Shared with the renderer's unresolved-token check. */
export const LOCALE_TOKEN_EXPRESSION = /\$\{(\S+?)\}/gm;

/** Resolves a token path against an object, or calls a function dictionary with the path segments. */
export type MessageDictionary = Record<string, unknown> | ((...parts: string[]) => unknown);

/** Reports one localisation problem. The renderer points this at its logger; the default warns on the console. */
let diagnostics: (message: string) => void = (message) => console.warn(message);

/**
 * Sets the sink that receives the localisation warnings.
 *
 * @param sink The warning sink of the platform.
 */
export function configureLocaleDiagnostics(sink: (message: string) => void): void {
  diagnostics = sink;
}

/**
 * Walks one dictionary along a path of names.
 *
 * @param target The dictionary, or the sub-object the walk reached.
 * @param nParts The remaining path segments. The walk consumes them.
 * @param curPath The path taken so far.
 * @returns The value the path reaches, or undefined when a segment is missing.
 */
function getMessage(target: unknown, nParts: string[], curPath: string[] = []): unknown {
  if (!Array.isArray(nParts) || nParts.length <= 0) {
    return target;
  }
  if (typeof target !== 'object') {
    return undefined;
  }
  const np = nParts.shift() as string;
  const subTarget = (target as Record<string, unknown>)[np];
  curPath.push(np);
  if (!subTarget) {
    return undefined;
  }
  return getMessage(subTarget, nParts, curPath);
}

/**
 * Replaces every `${token}` placeholder of one message from the dictionary.
 *
 * @param dictionary The replacement dictionary: an object of values, or a function that receives the token's segments.
 * @param message The message. A non-string value returns unchanged.
 * @returns The resolved message. An unresolved token keeps its full `${token}` form.
 * @throws Error when no dictionary is given.
 */
export function getLocalizedMessage(dictionary: MessageDictionary, message: unknown): unknown {
  // Parse messages and replace localized strings tokens when found.
  // Return unmodified message if not a localized string.
  if (!dictionary) {
    throw new Error('Missing dictionary!');
  }
  if (typeof message !== 'string') {
    return message;
  }
  const replaceOnce = (input: string): string => input.replaceAll(LOCALE_TOKEN_EXPRESSION, (match, msgName: string) => {
    msgName = msgName.trim();
    if (!msgName) {
      diagnostics(`The localised message "${match}" is invalid as it results into an empty name.`);
      return match;
    }
    if (!msgName.includes('.')) {
      if (typeof dictionary === 'object' && Object.hasOwn(dictionary, msgName)) {
        return String(dictionary[msgName]);
      } else if (typeof dictionary === 'function') {
        const strMsg = dictionary(msgName);
        return (typeof strMsg === 'string' ? strMsg : match);
      }
      return match;
    }
    const nameParts = msgName.split('.');
    if (typeof dictionary === 'function') {
      const strMsg = dictionary(...nameParts);
      return String(strMsg ?? match);
    } else if (typeof dictionary === 'object') {
      // Coalesce a missing path to the full ${token}: without this, getMessage returns undefined
      // and String.replaceAll substitutes the literal string "undefined" into the message.
      const resolved = getMessage(dictionary, nameParts);
      return String(resolved ?? match);
    }
    return match;
  });

  // Re-scan until the message stops changing, so a value that itself contains
  // a token (e.g. a help string embedding ${key.*}) resolves fully.
  // Cap the passes to break self-referential cycles (a token whose value contains the same token).
  let result = message;
  for (let pass = 0; pass < 10; pass++) {
    const next = replaceOnce(result);
    if (next === result) {
      return next;
    }
    result = next;
  }
  diagnostics(`Stopped resolving after 10 passes; possible self-referential token cycle in: ${message}`);
  return result;
}

/**
 * Resolves a message by path against a dictionary, with optional runtime-token replacement.
 *
 * @param dictionary The dictionary the path walks.
 * @param propNames The path segments. The last argument may be an object merged over the
 * dictionary as the replacement scope (the object overrides unresolved tokens), or a function
 * used directly as the replacement dictionary.
 * @returns The translated message.
 * @throws Error when the path resolves to no string.
 */
export function translate(dictionary: Record<string, unknown>, ...propNames: unknown[]): string {
  let replDict: MessageDictionary;
  const lastPropType = (propNames.length > 0 ? typeof propNames[propNames.length - 1] : undefined);
  if (lastPropType === 'object') {
    replDict = Object.assign({}, dictionary, propNames.pop());
  } else if (lastPropType === 'function') {
    replDict = propNames.pop() as (...parts: string[]) => unknown;
  } else {
    replDict = dictionary;
  }
  const msg = getMessage(dictionary, propNames as string[]);
  if (typeof msg !== 'string') {
    throw new Error(`propName "${propNames.join('.')}" couldn't be translated!`);
  }
  return getLocalizedMessage(replDict, msg) as string;
}
