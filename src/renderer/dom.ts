/**
 * Small DOM helpers shared by the renderer modules.
 */

/**
 * Queries one element by CSS selector.
 *
 * @param selector The CSS selector to query.
 * @returns The element.
 * @throws Error when the document does not contain the element.
 */
export function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Renderer bootstrap failed: missing required element ${selector}.`);
  }
  return element;
}
