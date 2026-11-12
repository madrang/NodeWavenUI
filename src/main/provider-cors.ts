/**
 * The CORS allowlist of the provider endpoints. The workspace page fetches its inference
 * endpoints cross-origin from `app://renderer`, and those endpoints answer no access-control
 * headers, so Chromium blocks the preflight before the provider reads one byte. The main process
 * owns the one webRequest filter that adds the missing headers, scoped to the base URLs the
 * workspace page registered from its provider registry.
 */

import { ipcMain, type Session } from 'electron';

const CHANNEL = 'nodewavenui';

/** The one origin the workspace pages fetch providers from. */
const APP_ORIGIN = 'app://renderer';

/** The allowed base URLs, normalized without a trailing slash. */
const allowedBases = new Set<string>();

/** True when one request URL falls under one allowed base. */
function urlAllowed(url: string): boolean {
  for (const base of allowedBases) {
    if (url === base || url.startsWith(`${base}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Reads one base URL the filter accepts.
 *
 * @param value The value to check. It can have any type.
 * @returns The normalized URL, or null when the value is no http or https URL string.
 */
function readBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Adds one response header when the server sent none of that name. */
function addHeader(headers: Record<string, string[]>, name: string, value: string): void {
  const exists = Object.keys(headers).some((key) => key.toLowerCase() === name);
  if (!exists) {
    headers[name] = [value];
  }
}

/**
 * Installs the webRequest filter and the bridge handler of the allowlist.
 * Runs once at app start, on the session the workspace window loads from.
 *
 * @param session The session the workspace pages load from.
 */
export function registerProviderCors(session: Session): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!urlAllowed(details.url)) {
      callback(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {});
      return;
    }
    const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
    addHeader(headers, 'access-control-allow-origin', APP_ORIGIN);
    if (details.method === 'OPTIONS') {
      // The preflight of the provider call: the answer needs the method and header grants.
      addHeader(headers, 'access-control-allow-methods', 'POST, OPTIONS');
      addHeader(headers, 'access-control-allow-headers', 'authorization, content-type, accept');
      addHeader(headers, 'access-control-max-age', '86400');
    }
    callback({ responseHeaders: headers });
  });
  ipcMain.handle(`${CHANNEL}:cors:allowProviders`, (_event, urls: unknown) => {
    if (!Array.isArray(urls)) {
      throw new Error('The provider CORS allowlist needs a list of base URLs.');
    }
    const bases = urls.map(readBaseUrl);
    if (bases.some((base) => base === null)) {
      throw new Error('The provider CORS allowlist holds a value that is no http or https URL.');
    }
    allowedBases.clear();
    for (const base of bases) {
      if (base) {
        allowedBases.add(base);
      }
    }
    return null;
  });
}
