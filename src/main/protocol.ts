/**
 * The app:// protocol of the main process. It serves the built renderer pages and the plugin
 * folders from one secure, standard scheme, so every page runs in a secure context (WebCrypto
 * needs it) under one stable origin, instead of the NW.js chrome-extension id that moved
 * between releases.
 */

import { net, protocol } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The absolute path of the app root, one level above the compiled main directory. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Marks the app:// scheme as standard, secure, and fetch-capable. Runs before the app is ready. */
export function registerAppProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/**
 * Maps one app:// address to the file it serves: `app://renderer/<path>` reads the built
 * renderer output, `app://plugins/<name>/<path>` reads the plugin folder of that name.
 * A relative import that climbs out of the renderer folder, for example `../shared/bridge.js`
 * from `app://renderer/index.js`, stays on the renderer host as `/shared/bridge.js`, because a
 * URL never crosses its host. Those paths fall back to the root of the build output.
 *
 * @param url The app:// address of a page or asset.
 * @returns The absolute file path, or null when the address names no file of the app.
 */
function toFilePath(url: string): string | null {
  const parsed = new URL(url);
  const segments = decodeURIComponent(parsed.pathname)
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  const bases =
    parsed.hostname === 'renderer' ?
      [
        join(APP_ROOT, 'dist', 'renderer'),
        join(APP_ROOT, 'dist'),
      ] :
      parsed.hostname === 'plugins' ?
        [join(APP_ROOT, 'plugins')] :
        [];
  // Plugin pages also ride the renderer host, so an iframe of one stays same-origin with the
  // workspace page and receives the page API the workspace injects.
  const rendererPlugins =
    parsed.hostname === 'renderer' && segments[0] === 'plugins' ?
      [{ base: join(APP_ROOT, 'plugins'), segments: segments.slice(1) }] :
      [];
  for (const candidate of [
    ...bases.map((base) => ({ base, segments })),
    ...rendererPlugins,
  ]) {
    const filePath = normalize(join(candidate.base, ...candidate.segments));
    if (filePath.startsWith(candidate.base + sep) && existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Builds the app:// address of one renderer page, for the windows the main process opens.
 *
 * @param pagePath The renderer-relative path, for example `index.html`.
 * @returns The absolute app:// address.
 */
export function rendererUrl(pagePath: string): string {
  return `app://renderer/${pagePath.replace(/^\/+/, '')}`;
}

/** Installs the app:// handler. Runs once the app is ready. */
export function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const filePath = toFilePath(request.url);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }
    return net
      .fetch(pathToFileURL(filePath).href)
      .catch(() => new Response('Not found', { status: 404 }));
  });
}
