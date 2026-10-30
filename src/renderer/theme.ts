/**
 * The theme registry of the app.
 * The theme palettes live in `themes/*.css`, one file per theme, selected by the `data-theme` attribute
 * on the root element. The workspace settings store holds the chosen theme id, and an absent or unknown
 * id falls back to "dark-gray". NW.js exposes no API for system colors, so the app owns its palette.
 */

/** One registered theme. */
export interface ThemeDefinition {
  readonly id: string;
  readonly label: string;
}

/** Every registered theme, in settings order. */
export const THEMES: readonly ThemeDefinition[] = [
  { id: 'dark-gray', label: 'Dark Gray' },
  { id: 'light-gray', label: 'Light Gray' },
  { id: 'dark-red', label: 'Dark Red' },
  { id: 'light-red', label: 'Light Red' },
  { id: 'dark-green', label: 'Dark Green' },
  { id: 'light-green', label: 'Light Green' },
  { id: 'dark-blue', label: 'Dark Blue' },
  { id: 'light-blue', label: 'Light Blue' },
  { id: 'legacy-phosphor', label: 'Legacy Phosphor' },
];

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
