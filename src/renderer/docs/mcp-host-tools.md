# MCP host tools

Every request is one JSON-RPC POST to the endpoint with the bearer token. The settings pane of the app shows the endpoint and the token.

| Tool | Arguments | What it does |
|---|---|---|
| `list_pages` | none | Lists the tracked pages: id, url, title, attached state, kind (`window`, `iframe`, `webview`), and for webview pages the `shared` state. |
| `open_uri` | `url`, `kind?`, `title?`, `width?`, `height?`, `frame?` | Opens one address as a page of the app. `kind` `iframe` loads the address inside the workspace page: it never attaches and carries no debug target of its own. `kind` `webview` (the default) loads it in its own guest process, with Node on for app-origin pages (`allownw`) and off for every other address. `kind` `window` opens a separate OS window, 900 x 700 unless `width` and `height` say otherwise; `frame` is `system` or `borderless`, and an omitted `frame` inherits the frame of the workspace window. `title` names the frame tab. A relative path resolves against the app root, and an absolute address loads as given. A webview page attaches only while the share switch of its title bar is on, and the attach still runs through the permission pipeline first. The page id joins the id space of `list_pages`, `close_page`, and every session tool. |
| `close_page` | `pageId` | Closes one page. With `--expose-main-window`, the main window is a tracked page too, and closing it drains every child first. |
| `attach_session` | `pageId` | Attaches a debug session and starts the console capture. Needed for evaluate and screenshot. |
| `detach_session` | `pageId` | Detaches the debug session. |
| `evaluate` | `pageId`, `expression` | Runs JavaScript in the page. A promise result is awaited; objects come back as parsed JSON values. No top-level `await`: use an async IIFE. Evaluated code opens the DevTools of its own page with `nodewavenui.windows.openDevTools()` when the page holds the bridge: a repeated call changes nothing, and `toggleDevTools()` flips them both ways. |
| `screenshot` | `pageId`, `format?` | Captures the page as base64 image data, png or jpeg. |
| `console_entries` | `pageId` | Reads the captured console lines since attach or the last clear. |
| `clear_console` | `pageId` | Clears the captured console. |
| `navigate` | `pageId`, `url` | Loads an address in the page. `data:` URLs are refused. |

# Resources

`resources/list` returns these harness documents, `resources/read` reads one by URI. All carry `text/markdown`.

# Permissions

Read tools (`attach_session`, `screenshot`, `console_entries`) run without a request. The mutating tools queue an approval card in the session tab of the app and block until the user answers. The "always" choice persists a rule.

# Sessions

Every MCP session (the `Mcp-Session-Id` you present, or a fresh one from `initialize`) gets its own chat tab that logs every tool call and result. A request waits forever until answered.

# Constraints

- The main window is trackable only when the app was launched with `--expose-main-window`.
- An attached session on the main window shows the Chromium debug banner on top of it, and while the banner shows the title-bar drag of the app breaks: the drag regions shift out of place. Detach the session when you are done; the drag comes back at once.
- One debugger holds one target: DevTools open on a page block a session attach.
- A page without the bridge — a remote webview guest or an external child window — opens its DevTools through the app menu, not from evaluated code.
- Two pages that show the same URL cannot be told apart by attach; the first unattached match wins.
