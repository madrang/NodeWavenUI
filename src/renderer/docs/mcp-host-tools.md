# MCP host tools

Every request is one JSON-RPC POST to the endpoint with the bearer token. The settings pane of the app shows the endpoint and the token.

| Tool | Arguments | What it does |
|---|---|---|
| `list_windows` | none | Lists the tracked windows: id, url, title, attached state. |
| `open_window` | `url`, `width?`, `height?`, `frame?` | Opens a child window (default 900 x 700) and returns its id. `frame` is `system` or `borderless`; omitted, it inherits the frame of the workspace window. |
| `close_window` | `childId` | Closes one child window. With `--expose-main-window`, the main window is a tracked child too, and closing it drains every child first. |
| `attach_session` | `childId` | Attaches a debug session and starts the console capture. Needed for evaluate and screenshot. |
| `detach_session` | `childId` | Detaches the debug session. |
| `evaluate` | `childId`, `expression` | Runs JavaScript in the child window. A promise result is awaited; objects come back as parsed JSON values. No top-level `await`: use an async IIFE. |
| `screenshot` | `childId`, `format?` | Captures the window as base64 image data, png or jpeg. |
| `console_entries` | `childId` | Reads the captured console lines since attach or the last clear. |
| `clear_console` | `childId` | Clears the captured console. |
| `navigate` | `childId`, `url` | Loads an address in the child window. `data:` URLs are refused. |
| `open_devtools` | `childId` | Opens the DevTools window. The DevTools outrank every session and detach it. SDK build only. |

# Resources

`resources/list` returns these harness documents, `resources/read` reads one by URI. All carry `text/markdown`.

# Permissions

Read tools (`attach_session`, `screenshot`, `console_entries`) run without a request. The mutating tools queue an approval card in the session tab of the app and block until the user answers. The "always" choice persists a rule.

# Sessions

Every MCP session (the `Mcp-Session-Id` you present, or a fresh one from `initialize`) gets its own chat tab that logs every tool call and result. A request waits forever until answered.

# Constraints

- The main window is trackable only when the app was launched with `--expose-main-window`.
- An attached session on the main window shows the Chromium debug banner on top of it, and while the banner shows the title-bar drag of the app breaks: the drag regions shift out of place. Detach the session when you are done; the drag comes back at once.
- One debugger holds one target: DevTools open on a child block a session attach.
- Two child windows that show the same URL cannot be told apart by attach; the first unattached match wins.
