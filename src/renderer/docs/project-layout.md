# Project layout

Where everything lives in the NodeWavenUI source tree. `tsc -b` compiles the sources into `dist/`, and the renderer assets (HTML, CSS, these documents) copy alongside.

```
src/
  shared/          contracts and small platform wrappers that every compile context shares
    workspace.ts     workspace directory and settings contracts with runtime guards
    permissions.ts   the principal kinds and permission targets
    mcp-endpoints.ts the stored MCP endpoint list contract
    bridge.ts        the nodewavenui bridge contract: fs, app facts, window calls, workspace services
    window-tools.ts  the window tool definitions the MCP host and the chat agent share
    node-access.ts   the page-context require wrapper (plugin and crypto loaders)
    records.ts       record guards for untyped boundary values (isRecord, asRecord)
  renderer/        UI code (DOM context)
    index.html             the launcher and setup wizard window
    main.html              the workspace window (settings and chat panes)
    graphs.html            the Graphs window, an SVG drawing surface
    editor.html            the Editor window, a plain-text editor on the EditContext API
    styles.css             the app styles; themes/ holds one palette file per theme
    docs/                  harness documents served to agents as MCP resources
    index.ts               launcher window: folder selection, unlock, wizard
    main-window.ts         opens the workspace window with the stored frame mode
    main-handoff.ts        the startup payload the launcher hands to the workspace window
    main.ts                workspace window boot: storage, the bridge routes, the MCP host start
    frame-mode.ts          the system-border / borderless registry
    theme.ts               theme discovery (built-in and app-root themes/ folders); mirrors the applied id for app pages
    graphs.ts              the Graphs window page and the nodewavenGraphs page global
    edit-context.ts        EditContext API type declarations (the DOM library predates the API)
    editor.ts              the Editor window page and the nodewavenEditor page global
    agent-tools.ts         the chat agent tool registry (built-ins, window tools over the bridge, native)
    mcp-client-adapter.ts  the MCP client surface over the bridge (states cached, calls forwarded)
    main-app.ts            tabs, settings panes, chat, permission cards
    permission-gate.ts     the permission pipeline and pending requests
    settings-store.ts      the per-workspace settings store
    chat-sessions.ts       chat session persistence: one file per chat, sealed with a storage-held chat key on password workspaces
    system-prompts.ts      the built-in system prompt sources of the chat menu (AGENTS.md harness plus workspace, none)
    plugin-folders.ts      the plugins/ folder scan, the manifest guard, the SHA-256 integrity gate, and the settings controller
    frames.ts              the embedded frame tiling manager: iframe and webview panels beside the panes, with their title bars and the webview share switch
    storage-setups.ts      the built-in storage setups for the wizard dropdown
    storage-shares.ts      read-only storage sharing with the chat agent
    storage-migration.ts   moves legacy backends forward
    workspace-picker.ts    directory selection through the native dialog of the main process
    workspace-files.ts     folder inspection and the workspace marker
    workspace-migration.ts versioned workspace data migration
    window-geometry.ts     remembers the workspace window placement
    plugin-fields.ts       renders plugin UI definitions (fields as data)
    plugins.ts             plugin manager: user-loaded providers and storage backends
    wizard.ts              the setup wizard screen
    notification-hub.ts    one hub for every notification
    doc-resources.ts       serves the harness documents on both surfaces
    json-viewer-element.ts collapsible JSON tree for tool results
    permission-request-element.ts  the approval card element
    node-context.ts        the app root path, read over the bridge
    window-ops.ts          window operations (size, placement, close, events) over the bridge
    file-system.ts         shared filesystem access over the bridge: path join, directory list, text and byte read, writes
    dom.ts                 element lookup helper
    arguments.ts           command line arguments
  main/            the Electron main process
    main.ts                bootstrap, the app:// protocol setup, the smoke probes, the tool service
    protocol.ts            the app:// scheme: dist/renderer, dist, and plugins/ on one secure origin
    services.ts            the ipc services: the fs slice, app facts, the directory dialog
    window-service.ts      the launcher and workspace windows, the handoff, the close drain
    session-service.ts     child windows, frame records, debug sessions, evaluate, screenshot
    mcp-host.ts            the MCP host: HTTP server, tools, token, sink pushes
    mcp-manager.ts         the MCP client manager and the page API (main side)
    mcp-client.ts          the MCP protocol client
    mcp-transport.ts       the MCP transports: streamable HTTP and stdio (native spawn)
    mcp-client-service.ts  the bridge routes of the MCP client and its state pushes
    workspace-link.ts      the main-to-workspace request and push link
    diagnostics.ts         the renderer console relay (--verbose mirrors every line)
  preload/          the contextBridge preloads, plain CJS
    app-preload.cjs        the nodewavenui bridge and the nodewavenMcp proxy, app origins only
    webview-preload.cjs    the same bridge inlined for frame guests, plus the guest announcement
  providers/       inference backends, one module per backend
    provider.ts       the InferenceProvider contract every backend implements
    openai.ts         OpenAI chat-completions endpoint (base URL plus API key)
    acp.ts            Agent Client Protocol agent (spawned process or WebSocket URL)
  storage/         storage backends, one module per backend
    storage.ts             the StorageBackend contract every backend implements
    node-access.ts         the crypto loader and the bridge fs slice for the storage layer
    encryption.ts          shared suites, envelopes, and key derivation for password encryption
    indexeddb.ts           IndexedDB key-value backend
    json-file.ts           JSON file backend with atomic writes
    password-encrypted.ts  password encryption wrapped over any backend
scripts/           build helper scripts, plain Node ESM
tsconfig.json      solution root (project references)
tsconfig.base.json strict shared compiler options
tsconfig.main.json      main process sources, compiled into dist/main/; references shared
tsconfig.shared.json    shared sources, compiled into dist/shared/
tsconfig.renderer.json  renderer sources; references shared, providers, storage
tsconfig.providers.json provider sources, compiled into dist/
tsconfig.storage.json   storage sources; references shared and providers
eslint.config.mjs ESLint flat config: typescript-eslint recommended plus the stylistic format
dist/              compiled output (gitignored)
```
