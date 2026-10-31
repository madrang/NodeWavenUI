/**
 * The theme registry of the app.
 * The themes are CSS files, discovered at startup from two folders: the built-in `dist/renderer/themes`
 * folder and the user-owned `themes` folder in the app root. A file `my-color.css` carries the theme id
 * "my-color" and must set the palette variables under `:root[data-theme='my-color']` (see the built-in
 * files for the variable list). A user file named like a built-in overrides it. The workspace settings
 * store holds the chosen theme id, and an absent or unknown id falls back to "dark-gray". NW.js exposes
 * no API for system colors, so the app owns its palette.
 */

import { joinPath, listDirectoryNames, readTextFile } from './file-system.js';
import { readAppRootPath } from './node-context.js';

/** One registered theme. */
export interface ThemeDefinition {
  readonly id: string;
  readonly label: string;
}

/**
 * Lists the CSS file names of one themes folder.
 *
 * @param directory The absolute folder path.
 * @param warnOnFailure True for the built-in folder, whose absence means a broken install. A missing user folder is the normal case.
 * @returns The file names sorted, or an empty list when the folder is missing or unreadable.
 */
function listThemeFiles(directory: string, warnOnFailure: boolean): readonly string[] {
  const names = listDirectoryNames(directory);
  if (names === null) {
    if (warnOnFailure) {
      console.warn(`[NodeWavenUI] the themes folder "${directory}" could not be read.`);
    }
    return [];
  }
  return names.filter((name) => name.endsWith('.css')).sort();
}

/** Builds the display label of a theme id: "legacy-phosphor" becomes "Legacy Phosphor". */
function labelOf(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** One discovered theme: the id, the label, the absolute file it came from, and whether the user folder owns it. */
interface DiscoveredTheme {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly fromUserFolder: boolean;
}

/**
 * Discovers the themes from the built-in folder and the user folder.
 * A user file named like a built-in replaces the built-in entry.
 *
 * @returns The themes sorted by id, or an empty list outside NW.js.
 */
function discoverThemes(): readonly DiscoveredTheme[] {
  const root = readAppRootPath();
  if (root === null) {
    console.warn('[NodeWavenUI] the app root could not be read, the theme discovery found nothing.');
    return [];
  }
  const folders: readonly { readonly directory: string; readonly warnOnFailure: boolean; readonly fromUserFolder: boolean }[] = [
    { directory: joinPath(root, 'dist/renderer/themes'), warnOnFailure: true, fromUserFolder: false },
    { directory: joinPath(root, 'themes'), warnOnFailure: false, fromUserFolder: true },
  ];
  const byId = new Map<string, DiscoveredTheme>();
  for (const folder of folders) {
    for (const name of listThemeFiles(folder.directory, folder.warnOnFailure)) {
      const id = name.slice(0, -'.css'.length);
      if (id.length > 0) {
        byId.set(id, { id, label: labelOf(id), file: joinPath(folder.directory, name), fromUserFolder: folder.fromUserFolder });
      }
    }
  }
  return [...byId.values()].sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
}

const discovered = discoverThemes();

/** Every registered theme, in id order. */
export const THEMES: readonly ThemeDefinition[] = discovered.map((theme) => ({ id: theme.id, label: theme.label }));

/** The theme the app uses when the settings store holds no theme or an unknown one. */
export const DEFAULT_THEME_ID = 'dark-gray';

/** The local storage key that mirrors the applied theme, so same-origin app pages follow the active theme. */
export const THEME_MIRROR_KEY = 'app-theme';

/**
 * Checks that a value names a registered theme.
 *
 * @param value The value to check. It can have any type.
 * @returns True when a theme carries the id.
 */
export function isKnownThemeId(value: unknown): value is string {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value);
}

/**
 * Resolves a stored value into a theme id, with the default applied.
 *
 * @param stored The stored value from the workspace settings, or null.
 * @returns The theme id, "dark-gray" when the stored value is absent or unknown.
 */
export function resolveThemeId(stored: string | null): string {
  return isKnownThemeId(stored) ? stored : DEFAULT_THEME_ID;
}

/**
 * Applies one theme to the document and mirrors it, so same-origin app pages follow the active theme.
 *
 * @param themeId The theme id. An unknown id applies the default.
 */
export function applyTheme(themeId: string): void {
  const resolved = resolveThemeId(themeId);
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(THEME_MIRROR_KEY, resolved);
}

/**
 * Applies the default theme at startup, before any workspace opens.
 */
export function initializeTheme(): void {
  applyTheme(DEFAULT_THEME_ID);
}

/**
 * Injects one style element per discovered theme, except the built-in files the page already links.
 * The user folder sits outside the extension, so the page reads the file text instead of linking it.
 * An injected user theme lands after the static link, so it overrides a built-in with the same name.
 */
function injectThemeStyles(): void {
  const linked = new Set(
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((link) => link.getAttribute('href')),
  );
  for (const theme of discovered) {
    const name = theme.file.slice(theme.file.lastIndexOf('/') + 1);
    if (!theme.fromUserFolder && linked.has(`themes/${name}`)) {
      continue;
    }
    const text = readTextFile(theme.file);
    if (text === null) {
      console.warn(`[NodeWavenUI] the theme file "${theme.file}" could not be loaded.`);
      continue;
    }
    const style = document.createElement('style');
    style.dataset.themeFile = name;
    style.textContent = text;
    document.head.append(style);
  }
}

injectThemeStyles();
