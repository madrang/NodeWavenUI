/**
 * The frame manager of the workspace page: embedded views of the center workspace. The main
 * process owns the frame records and the permission checks; this module builds the views it is
 * asked to build — one tab each in the workarea strip — and answers the frame commands the main
 * process pushes. An iframe frame loads app content inside the workspace page. A webview frame
 * loads content in its own guest process, which carries its own debug target behind the share
 * switch of its tab.
 */

import { readBridge } from '../shared/bridge.js';
import { getWorkarea } from './workarea.js';

/** The kind of one embedded frame. An iframe shares the workspace page, a webview runs its own guest process. */
export type FrameKind = 'iframe' | 'webview';

/** The column one frame asked for. The frames tile into the center workspace today; the main
 * process still sends the field, so older callers keep working. */
export type FrameSide = 'left' | 'right';

/** The open arguments of one frame. */
export interface OpenFrameOptions {
  /** The address the frame loads. A relative path resolves against the app root. */
  readonly url: string;
  readonly kind: FrameKind;
  /** The column of the frame. The frames tile into the center workspace today; the field stays
   * accepted so older callers keep working. */
  readonly side?: FrameSide;
  /** The title the tab shows. Defaults to the last path segment of the address. */
  readonly title?: string;
}

/** The public answer of one open: the frame id, its kind, and its column. */
export interface FrameOpenResult {
  readonly frameId: number;
  readonly kind: FrameKind;
  readonly side: FrameSide;
}

/** The build request the main process sends for one new frame. */
export interface FrameBuildRequest {
  readonly id: number;
  readonly kind: FrameKind;
  readonly url: string;
  readonly title: string;
  readonly side: FrameSide;
}

/** The frame command the main process pushes for one tracked frame. */
export type FrameCommand = { readonly id: number; readonly command: 'close' } | { readonly id: number; readonly command: 'navigate'; readonly url: string };

/**
 * Checks that a value names one frame kind.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value is "iframe" or "webview".
 */
export function isFrameKind(value: unknown): value is FrameKind {
  return value === 'iframe' || value === 'webview';
}

/**
 * Checks that a value names one frame side.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value is "left" or "right".
 */
export function isFrameSide(value: unknown): value is FrameSide {
  return value === 'left' || value === 'right';
}

/** True when a frame address carries a scheme, so it is absolute. */
function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Maps one frame address to the address the embed loads.
 * A relative path resolves against the origin of the workspace page, whose root is the app
 * root. An absolute address loads as given.
 *
 * @param url The frame address from the open arguments.
 * @param origin The origin of the workspace page, for example `app://renderer`.
 * @returns The address for the embed.
 */
export function resolveFrameUrl(url: string, origin: string): string {
  if (isAbsoluteUrl(url)) {
    return url;
  }
  return `${origin.replace(/\/+$/, '')}/${url.replace(/^[/\\]+/, '')}`;
}

/** The absolute path of the app root, read once so the guest preload path resolves. */
let appRoot = '';

/** The title label of one address: the last path segment without its query, or the address itself. */
function titleOf(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  return clean.split('/').filter((part) => part.length > 0).at(-1) ?? url;
}

/** The views of one frame id, so the frame commands find them. */
const panels = new Map<number, { readonly content: HTMLDivElement; readonly setUrl: (url: string) => void }>();

/** Builds the view of one frame the main process registered: one tab in the workarea strip. */
function buildFramePanel(request: FrameBuildRequest): void {
  const bridge = readBridge();
  if (!bridge) {
    throw new Error('The frame views need the nodewavenui bridge of an app window.');
  }
  const workarea = getWorkarea();
  const content = document.createElement('div');
  content.className = 'frame-view';
  const viewId = `frame:${request.id}`;
  const setUrl = (url: string): void => {
    workarea.setLabel(viewId, titleOf(url));
    if (embed instanceof HTMLIFrameElement) {
      embed.src = url;
    } else {
      embed.setAttribute('src', url);
    }
  };
  let embed: HTMLIFrameElement | HTMLElement;
  if (request.kind === 'webview') {
    const webview = document.createElement('webview');
    webview.setAttribute('preload', `file://${appRoot}/src/preload/webview-preload.cjs`);
    // The token binds the guest to its frame record: the guest preload announces it.
    webview.setAttribute('src', `${request.url}${request.url.includes('?') ? '&' : '?'}nvframe=${request.id}`);
    webview.addEventListener('did-navigate', (event) => {
      const url = (event as Event & { url?: string }).url;
      if (typeof url === 'string' && url.length > 0) {
        workarea.setLabel(viewId, titleOf(url));
      }
    });
    embed = webview;
  } else {
    const iframe = document.createElement('iframe');
    // A plugin page rides the renderer host, so it stays same-origin with the workspace page.
    iframe.src = request.url.replace('app://plugins/', 'app://renderer/plugins/');
    iframe.addEventListener('load', () => {
      // The page API injects into same-origin iframes, the way it always reached app pages.
      try {
        const target = iframe.contentWindow as { nodewavenMcp?: unknown } | null;
        if (target) {
          target.nodewavenMcp = (globalThis as { nodewavenMcp?: unknown }).nodewavenMcp;
        }
      } catch {
        // A cross-origin page refuses the globals and stays without them.
      }
    });
    embed = iframe;
  }
  content.append(embed);
  workarea.register(viewId, {
    label: request.title,
    badge: request.kind,
    title:
      request.kind === 'webview' ?
        'A webview frame runs its own guest process and carries its own debug target.' :
        'An iframe frame shares the process and the debug target of the workspace window.',
    content,
    ...(request.kind === 'webview' ?
      {
        actions: (group: HTMLElement): void => {
          const share = document.createElement('button');
          share.type = 'button';
          share.className = 'frame-share';
          share.textContent = 'Not shared';
          share.setAttribute('aria-pressed', 'false');
          share.title = 'Sharing decides whether a debug session may attach. Attach still runs through the permission pipeline first.';
          share.addEventListener('click', () => {
            const shared = share.getAttribute('aria-pressed') !== 'true';
            share.textContent = shared ? 'Shared' : 'Not shared';
            share.setAttribute('aria-pressed', `${shared}`);
            void bridge.workspace.notifyFrameShared(request.id, shared);
          });
          group.append(share);
        },
      } :
      {}),
    onClose: () => {
      void bridge.workspace.closeFrameAsUser(request.id);
    },
  });
  panels.set(request.id, { content, setUrl });
}

/** Removes the view of one frame from the workarea. */
function removeFramePanel(id: number): void {
  const entry = panels.get(id);
  if (!entry) {
    return;
  }
  panels.delete(id);
  getWorkarea().unregister(`frame:${id}`);
  entry.content.remove();
}

/**
 * Serves the frame channels of the workspace page: the build requests route through the shared
 * request router, and the pushed commands land in the panels.
 *
 * @param route The router registration of the workspace page.
 */
export async function serveFrames(
  route: (channel: string, handler: (payload: unknown) => Promise<unknown>) => void,
): Promise<void> {
  const bridge = readBridge();
  if (!bridge) {
    return;
  }
  appRoot = await bridge.app.appRoot();
  route('frames.build', async (payload) => {
    const request = payload as FrameBuildRequest | null;
    if (typeof request?.id !== 'number' || !isFrameKind(request.kind) || typeof request.url !== 'string') {
      throw new Error('The frame build request breaks its shape.');
    }
    buildFramePanel({ id: request.id, kind: request.kind, url: request.url, title: request.title, side: isFrameSide(request.side) ? request.side : 'right' });
    return null;
  });
  bridge.workspace.onWorkspaceEvent('frames.command', (payload) => {
    const command = payload as FrameCommand | null;
    if (typeof command?.id !== 'number') {
      return;
    }
    if (command.command === 'close') {
      removeFramePanel(command.id);
      return;
    }
    panels.get(command.id)?.setUrl(command.url);
  });
}
