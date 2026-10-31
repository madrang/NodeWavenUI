# NodeWavenUI

A desktop AI workspace where agents do more than chat: they open windows, build pages, and debug them live.

NodeWavenUI is an NW.js app (Chromium plus Node.js in one process). Its chat agent carries a full set of window tools: it opens child windows, attaches Chromium debug sessions to them, evaluates JavaScript, reads captured consoles, takes screenshots, navigates, and opens DevTools. An agent can build a page, drive it, and inspect its own work end to end. The built-in Graphs window shows the pattern: the agent opens it, draws SVG graphs through a page global, and verifies the result with a screenshot.

Two MCP surfaces multiply what agents can reach:

- **The MCP host** serves the same window and debug tools to external agents over HTTP. Every request carries a bearer token, and every gated action shows an approval card in the app until the user answers.
- **The MCP client** connects remote MCP servers (streamable HTTP or stdio). Tools from endpoints in Native mode join the chat agent under `<label>.<tool>`, so any MCP server becomes part of the workspace.

## Highlights

- **Agent-driven windows** — open, close, and navigate child windows; attach debug sessions through the Chromium debugger (SDK build); capture consoles and screenshots; open DevTools. The chat agent and the MCP host share the exact same tool implementations.
- **The Graphs window** — an empty SVG surface agents draw on through the `nodewavenGraphs` page global (`line`, `scatter`, `bars`, `clear`). Colors follow the active theme.
- **The page API** — every child window receives the `nodewavenMcp` global, so evaluated code reaches the connected MCP endpoints from any window.
- **Permission model** — principals (user, plugin, mcp, agent) with per-action rules. Gated actions queue approval cards in the chat with an Always checkbox that persists a rule.
- **Workspaces** — any folder with a `.nodewavenui.json` marker. Pluggable storage backends (JSON file, IndexedDB) with optional password encryption (PBKDF2 or scrypt, AES-GCM or ChaCha20-Poly1305). Workspaces can share storages with the chat agent read-only.
- **Providers** — OpenAI-compatible chat-completions endpoints (streaming replies, reasoning disclosures, tool-calling loop) and ACP agents (spawned process or WebSocket).
- **The UI** — a borderless launcher and setup wizard, then a workspace window that opens with the system border or borderless (per-workspace setting). Nine themes, chat tabs, and one tab per MCP session that logs its tool traffic.

## The three agent surfaces

1. **The chat agent** (in-app). Built-ins (`evaluate`, `read`), the full window tool set (`list_windows`, `open_window`, `close_window`, `attach_session`, `detach_session`, `screenshot`, `console_entries`, `clear_console`, `navigate`, `open_devtools`), and native tools of the connected MCP endpoints.
2. **The MCP host** (external, `--mcp-host=<port>`). The same tools over HTTP, plus harness documents served as MCP resources that teach an agent the surfaces.
3. **Child windows.** Pages the app opens and tracks, reachable through the tools above and carrying the `nodewavenMcp` page global.

## Prerequisites
- Node.js 22 or newer. Development uses 24.14.1 through nvm: `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"`.
- A Linux desktop with X11, to run the app.

## Setup

```sh
npm install
```

Installs TypeScript and the NW.js SDK build. The flavor is configured in `.npmrc` through `nwjs_build_type=sdk`. npm prints a harmless "Unknown project config" warning about that key.

## Commands

| Command           | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `npm run build`   | Compile TypeScript and copy assets into `dist/`        |
| `npm start`       | Build, then launch the app                             |
| `npm run watch`   | Copy assets once, then recompile TypeScript on change  |
| `npm run clean`   | Remove `dist/`                                         |

`npm start` returns while the app keeps running, because the `nw` launcher spawns the app and exits. Close the workspace window to exit. `chromium-args` in `package.json` routes `console.*` output to the terminal.

## Command line

| Argument | Effect |
| --- | --- |
| `<workspace path>` | Open this workspace at startup instead of the launcher. |
| `--mcp-host=<port>[:<interface>]` | Start the MCP host for external agents. Binds to 127.0.0.1 without an interface. The token shows in the settings pane. |
| `--expose-main-window` | Track the workspace window like a child window, so agents reach it with the tools. Dangerous: an agent that breaks the page bricks the app. |
| `--version` / `--help` | Print and quit. |

## First run

1. Pick a folder in the launcher. An empty folder runs the setup wizard; a folder with a marker opens at once.
2. Add a provider in the settings tab (endpoint base URL and API key).
3. Chat. Ask the agent to create a new UI window and build something in it. Things to try:

   - "Open a new window and build a pomodoro timer in it."
   - "Make a window that shows a live clock, then screenshot it to check the layout."
   - "Create the graphs window and plot a sine over one period."
   - "Build a color palette picker in a window, then read its console for errors."

## Project layout

The full source layout lives in [`src/renderer/docs/project-layout.md`](src/renderer/docs/project-layout.md). The app serves it to agents as an MCP resource too: `harness:///nodewavenui/project-layout.md`.

## Conventions
- Compiled TypeScript, no bundler. `tsc -b` emits one `.js` file and one `.d.ts` file per module. NW.js loads them as native ES modules.
- Each context gets its own tsconfig, listed in the root solution. `tsc -b` type-checks every referenced project.
- Validate values that do not come from the type system (DOM events, files) with runtime guards at module boundaries.
- Imports use explicit `.js` extensions.
- The app owns its theme palette: one CSS file per theme under `src/renderer/themes/`, chosen per workspace through the registry in `theme.ts`. `applyTheme` mirrors the applied id into local storage, so app pages like the Graphs window follow the active theme.
- Plugin UI is data: a plugin carries `PluginFieldDefinition` fields, `plugin-fields.ts` renders them, and `readConfiguration` validates the values. Every surface shows the same controls for the same plugin.

## Status

Early (0.1.0), under active development. Verified on Linux with X11. MIT license.
