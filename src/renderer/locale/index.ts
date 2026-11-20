/**
 * The renderer localisation module.
 * `init` picks the language — the requested one, else the navigator preference — loads its
 * dictionary, and mirrors the choice to the local storage, so every same-origin page of the app
 * boots in the same language. `localizeHTML` walks a DOM tree (the document, or the content of
 * one view template) and resolves every `${token}` placeholder of the text, the attributes, and
 * the template contents against the dictionary. The dictionaries live as modules, so the
 * compiled registry stays typed and testable.
 */

import { configureLocaleDiagnostics, getLocalizedMessage, LOCALE_TOKEN_EXPRESSION, translate } from '../../shared/locale.js';
import { log } from '../logger.js';
import { EN } from './en.js';
import { FR } from './fr.js';

configureLocaleDiagnostics((message) => log.locale.warning(message));

/** One language id of the app. */
export type LanguageId = 'en' | 'fr';

/** The local storage key that mirrors the language, so same-origin app pages boot in it. */
export const LANGUAGE_MIRROR_KEY = 'app-language';

/** Every language the app carries, with its display label. The labels stay in their own language. */
export const LANGUAGES: readonly { readonly id: LanguageId; readonly label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
];

/** The ids of every available language, in registry order. */
export const availableLanguages: readonly LanguageId[] = LANGUAGES.map((language) => language.id);

/** The dictionary of each language. */
const DICTIONARIES: Record<LanguageId, Record<string, unknown>> = { en: EN, fr: FR };

/** The language the module loaded. */
let language: LanguageId = 'en';

/** The loaded dictionary. */
let dictionary: Record<string, unknown> = EN;

/**
 * Reads the language the navigator prefers.
 *
 * @returns The first navigator language the app carries, else the first available language.
 */
function getLanguage(): LanguageId {
  if (navigator.languages) {
    for (const lc of navigator.languages) {
      if (availableLanguages.includes(lc as LanguageId)) {
        return lc as LanguageId;
      }
    }
  }
  if (navigator.language && availableLanguages.includes(navigator.language as LanguageId)) {
    return navigator.language as LanguageId;
  }
  return availableLanguages[0] as LanguageId;
}

/**
 * Loads the dictionary of one language and mirrors the choice.
 *
 * @param requested The language to load, or null to use the navigator preference.
 * @returns The loaded language.
 * @throws Error when a requested language is not available.
 */
export function init(requested?: string | null): LanguageId {
  if (requested && !availableLanguages.includes(requested as LanguageId)) {
    throw new Error(`Language ${requested} isn't available!`);
  }
  language = (requested as LanguageId) || getLanguage();
  dictionary = DICTIONARIES[language];
  document.documentElement.lang = language;
  localStorage.setItem(LANGUAGE_MIRROR_KEY, language);
  return language;
}

/**
 * Reads the loaded language.
 *
 * @returns The language `init` loaded.
 */
export function currentLanguage(): LanguageId {
  return language;
}

/**
 * Resolves every `${token}` placeholder of one message against the loaded dictionary.
 *
 * @param message The message with its placeholders.
 * @returns The resolved message.
 */
export function resolveMessage(message: string): string {
  const resolved = getLocalizedMessage(dictionary, message);
  if (typeof resolved === 'string') {
    const unresolved = resolved.match(LOCALE_TOKEN_EXPRESSION);
    if (unresolved) {
      log.locale.error(`Unresolved tokens in message: ${unresolved.join(', ')}`);
    }
    return resolved;
  }
  return message;
}

/**
 * Translates one dictionary path, with optional runtime tokens.
 *
 * @param propNames The path segments. A trailing object supplies runtime token values.
 * @returns The translated message.
 * @throws Error when the path resolves to no string.
 */
export function translateMessage(...propNames: unknown[]): string {
  return translate(dictionary, ...propNames);
}

/**
 * Resolves every `${token}` placeholder of one node and its subtree: the text of childless
 * elements, every attribute value, the values of text and comment nodes, and the contents of
 * template elements. SVG elements stay untouched, with one warning.
 *
 * @param element The node to localize.
 */
export function localizeHTML(element: Node): void {
  if (!(element instanceof Node)) {
    log.localizeHTML.warning('Unknown instance type "%o" is unsupported.', element);
    return;
  }
  if (element.nodeName === 'TEMPLATE') {
    for (const node of Array.from((element as HTMLTemplateElement).content.childNodes)) {
      localizeHTML(node);
    }
    return;
  }
  const hasChildNodes = element.hasChildNodes();
  if (element instanceof Element) {
    if (element.hasAttributes()) {
      for (const attrib of Array.from(element.attributes).reverse()) {
        attrib.value = resolveMessage(attrib.value);
      }
    }
    if (element instanceof HTMLElement) {
      if (!hasChildNodes) {
        element.innerText = resolveMessage(element.innerText);
      }
    } else if (element instanceof SVGElement) {
      // Icons are the expected SVG case, so the skip stays at debug level.
      log.localizeHTML.debug('SVG elements are unsupported. Returning unmodified element');
    } else {
      log.localizeHTML.warning(`Unknown element "${element.id}" Returning unmodified element %o`, element);
    }
  } else if (
    // Text based nodes.
    element.nodeType === Node.COMMENT_NODE ||
    element.nodeType === Node.TEXT_NODE ||
    element instanceof CDATASection ||
    element instanceof Comment ||
    element instanceof Text
  ) {
    element.nodeValue = resolveMessage(element.nodeValue ?? '');
  } else if (element.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    log.localizeHTML.warning(`Unknown node type "${element.nodeName}.nodeType: ${element.nodeType}`);
  }
  if (hasChildNodes) {
    for (const node of Array.from(element.childNodes)) {
      localizeHTML(node);
    }
  }
}
