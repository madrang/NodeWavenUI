/**
 * The view template loader.
 * One view lives in one folder under `views/<name>/`: `template.html` carries the
 * markup with its `${token}` placeholders, `styles.css` carries the styles of the view, and a
 * view module mounts both. The build copies the whole folder into `dist/renderer/`, so the
 * pages fetch the assets from their own origin. This module holds no DOM tree of its own: it
 * loads, and the caller mounts and wires.
 */

/** The style sheets this module adopted, keyed by their source URL, so no view adopts twice. */
const adopted = new Map<string, CSSStyleSheet>();

/**
 * Loads one HTML template as a parsed, detached template element.
 *
 * @param url The URL of the template file.
 * @returns The template element. Its `content` fragment is ready to walk or to append.
 * @throws Error when the fetch fails.
 */
export async function loadTemplate(url: string): Promise<HTMLTemplateElement> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The template "${url}" could not load: ${response.status} ${response.statusText}`);
  }
  const template = document.createElement('template');
  template.innerHTML = await response.text();
  return template;
}

/**
 * Adopts one CSS file into the document as a constructable style sheet. Calling twice with the
 * same URL adopts nothing the second time.
 *
 * @param url The URL of the style sheet file.
 * @throws Error when the fetch or the parse fails.
 */
export async function adoptStyles(url: string): Promise<void> {
  if (adopted.has(url)) {
    return;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The style sheet "${url}" could not load: ${response.status} ${response.statusText}`);
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await response.text());
  adopted.set(url, sheet);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
