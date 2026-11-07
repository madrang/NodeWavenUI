/**
 * The frame tiling manager: embedded frames of the workspace window, in columns beside the
 * chat and settings panes. An iframe frame loads app content inside the workspace page. A
 * webview frame loads content in its own guest process, which carries its own debug target.
 * Every frame shows a title bar with a kind badge, a hide control, a close control, and for
 * webview frames a share switch: a webview that is not shared denies every debug attach even
 * after the permission pipeline passed (see the attach order in `window-manager.ts`).
 */

import type { ChildWindowManager, FrameEmbed, WindowCaller } from './window-manager.js';

/** The kind of one embedded frame. An iframe shares the workspace page, a webview runs its own guest process. */
export type FrameKind = 'iframe' | 'webview';

/** The column one frame tiles into, beside the panes. */
export type FrameSide = 'left' | 'right';

/** The open arguments of one frame. */
export interface OpenFrameOptions {
  /** The address the frame loads. A relative path resolves against the app root. */
  readonly url: string;
  readonly kind: FrameKind;
  /** The column of the frame. Defaults to right. */
  readonly side?: FrameSide;
  /** The title the title bar shows. Defaults to the last path segment of the address. */
  readonly title?: string;
}

/** The public answer of one open: the frame id, its kind, and its column. */
export interface FrameOpenResult {
  readonly frameId: number;
  readonly kind: FrameKind;
  readonly side: FrameSide;
}

/** The slice of the webview element API the frame manager uses. */
interface WebviewElement extends HTMLElement {
  readonly showDevTools: () => void;
  readonly terminate: () => void;
}

/** The loadcommit event of a webview guest: the committed address and its frame level. */
interface WebviewCommitEvent extends Event {
  readonly url: string;
  readonly isTopLevel: boolean;
}

/** Reads the DOM element behind one id, or throws when the page lacks it. */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(id);
  if (!element) {
    throw new Error(`The element ${id} is missing from the page.`);
  }
  return element as T;
}

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
 * root. An iframe loads it same-origin, and a webview guest holds the extension origin, so
 * the module scripts of an app page run in both. An absolute address loads as given.
 *
 * @param url The frame address from the open arguments.
 * @param origin The origin of the workspace page, for example `chrome-extension://<id>`.
 * @returns The address for the embed.
 */
export function resolveFrameUrl(url: string, origin: string): string {
  if (isAbsoluteUrl(url)) {
    return url;
  }
  return `${origin.replace(/\/+$/, '')}/${url.replace(/^[/\\]+/, '')}`;
}

/** The default title of one frame: the last path segment of its address, or the address itself. */
function defaultFrameTitle(url: string): string {
  const segment = url.split('/').filter((part) => part.length > 0).at(-1);
  return segment ?? url;
}

/** Builds and owns the frame panels of the workspace window. */
export class FrameManager {
  /**
   * @param manager The window manager that tracks the frames and owns their debug sessions.
   * @param origin The origin of the workspace page, for relative frame addresses.
   */
  constructor(
    private readonly manager: ChildWindowManager,
    private readonly origin: string,
  ) {}

  /**
   * Opens one embedded frame beside the panes.
   * The open runs through the same permission path as a child window open, so the default ask
   * of the agent and MCP principals applies.
   *
   * @param caller The caller that opens the frame.
   * @param options The frame address, kind, column, and title.
   * @returns The frame id from the child id space, with the kind and the column.
   * @throws Error when the permission pipeline denies the open.
   */
  async openFrame(caller: WindowCaller, options: OpenFrameOptions): Promise<FrameOpenResult> {
    const side: FrameSide = options.side ?? 'right';
    const url = resolveFrameUrl(options.url, this.origin);
    await this.manager.requireFrameOpen(caller, url);
    const title = options.title !== undefined && options.title.length > 0 ? options.title : defaultFrameTitle(url);
    const built = this.buildPanel(options.kind, url, title, side);
    const frameId = this.manager.registerFrame(url, title, built.embed);
    built.panel.dataset.frameId = String(frameId);
    return { frameId, kind: options.kind, side };
  }

  /**
   * Builds one frame panel with its title bar and its embed.
   *
   * @param kind The frame kind.
   * @param url The address the embed loads.
   * @param title The title the title bar shows.
   * @param side The column the panel joins.
   * @returns The embed the window manager drives, and the panel element.
   */
  private buildPanel(kind: FrameKind, url: string, title: string, side: FrameSide): { readonly embed: FrameEmbed; readonly panel: HTMLDivElement } {
    const column = requireElement<HTMLDivElement>(side === 'left' ? '#frames-left' : '#frames-right');
    const panel = document.createElement('div');
    panel.className = 'frame-panel';

    const titlebar = document.createElement('div');
    titlebar.className = 'frame-titlebar';
    const badge = document.createElement('span');
    badge.className = `frame-kind ${kind}`;
    badge.textContent = kind;
    badge.title =
      kind === 'webview'
        ? 'A webview frame runs its own guest process and carries its own debug target.'
        : 'An iframe frame shares the process and the debug target of the workspace window.';
    const label = document.createElement('span');
    label.className = 'frame-title';
    label.textContent = title;
    titlebar.append(badge, label);

    const content = document.createElement('div');
    content.className = 'frame-content';
    let embed: FrameEmbed;
    if (kind === 'webview') {
      const webview = document.createElement('webview') as WebviewElement;
      webview.setAttribute('partition', 'trusted');
      // No allownw: a guest stays without Node, even for app pages.
      webview.setAttribute('src', url);
      // The guest reports every committed top-level address, whatever drove the navigation:
      // a src swap, a debug-protocol navigate, or a link the guest followed on its own.
      // The first commit matches the open, so a custom title survives it.
      let committedUrl = url;
      webview.addEventListener('loadcommit', (event) => {
        const commit = event as WebviewCommitEvent;
        if (!commit.isTopLevel) {
          return;
        }
        const id = Number(panel.dataset.frameId);
        if (!Number.isFinite(id) || id <= 0) {
          return;
        }
        if (commit.url !== committedUrl) {
          committedUrl = commit.url;
          label.textContent = defaultFrameTitle(commit.url);
        }
        this.manager.noteFrameUrl(id, commit.url);
      });
      embed = {
        kind,
        shared: false,
        close: () => {
          try {
            webview.terminate();
          } catch {
            // A guest that already left needs no termination.
          }
          panel.remove();
          column.hidden = column.childElementCount === 0;
        },
        navigate: (next) => {
          webview.setAttribute('src', next);
        },
        openDevTools: () => {
          webview.showDevTools();
        },
        readTitle: () => null,
        injectGlobals: () => {},
      };
      content.append(webview);
    } else {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      embed = {
        kind,
        shared: false,
        close: () => {
          panel.remove();
          column.hidden = column.childElementCount === 0;
        },
        navigate: (next) => {
          iframe.src = next;
          label.textContent = defaultFrameTitle(next);
        },
        openDevTools: null,
        readTitle: () => {
          try {
            return iframe.contentDocument?.title ?? null;
          } catch {
            return null;
          }
        },
        injectGlobals: (globals) => {
          try {
            const target = iframe.contentWindow as { nodewavenMcp?: unknown } | null;
            if (target) {
              target.nodewavenMcp = globals;
            }
          } catch {
            // A cross-origin page refuses the globals and stays without them.
          }
        },
      };
      content.append(iframe);
    }

    if (kind === 'webview') {
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'frame-share';
      share.textContent = 'Not shared';
      share.setAttribute('aria-pressed', 'false');
      share.title = 'Sharing decides whether a debug session may attach. Attach still runs through the permission pipeline first.';
      share.addEventListener('click', () => {
        embed.shared = !embed.shared;
        share.textContent = embed.shared ? 'Shared' : 'Not shared';
        share.setAttribute('aria-pressed', `${embed.shared}`);
      });
      titlebar.append(share);
    }

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'frame-hide';
    hide.textContent = '–';
    hide.title = 'Hide the frame content. The frame stays and a webview guest keeps running.';
    hide.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'frame-close';
    close.textContent = '×';
    close.title = 'Close the frame.';
    close.addEventListener('click', () => {
      const id = Number(panel.dataset.frameId);
      if (Number.isFinite(id) && id > 0) {
        void this.manager.closeChild({ principal: 'user' }, id);
      }
    });
    titlebar.append(hide, close);
    panel.append(titlebar, content);
    column.hidden = false;
    column.append(panel);
    return { embed, panel };
  }
}
