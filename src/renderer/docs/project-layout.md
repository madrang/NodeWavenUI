# Project layout

Where everything lives in the NodeWavenUI source tree. `tsc -b` compiles the sources into `dist/`, and the renderer assets (HTML, CSS, these documents) copy alongside.

```
src/
  shared/          contracts and small platform wrappers that every compile context shares
    workspace.ts     workspace directory and settings contracts with runtime guards
    permissions.ts   the principal kinds and permission targets
    mcp-endpoints.ts the stored MCP endpoint list contract
    nw.ts            NW.js window wrappers: open, resize, frame, events
    node-access.ts   the NW.js page context: require global, module load, platform read
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
    main.ts                workspace window: storage, chat context, MCP host, close drain
    frame-mode.ts          the system-border / borderless registry
    theme.ts               theme discovery (built-in and app-root themes/ folders); mirrors the applied id for app pages
    graphs.ts              the Graphs window page and the nodewavenGraphs page global
    edit-context.ts        EditContext API type declarations (the DOM library predates the API)
    editor.ts              the Editor window page and the nodewavenEditor page global
    window-manager.ts      child windows: open, track, debug sessions, evaluate
    mcp-host.ts            the MCP host: HTTP server, tools, resources, token
    agent-tools.ts         the chat agent tool registry (built-ins, window tools, native)
    mcp-client/            the MCP client: transports, protocol, endpoint manager
    main-app.ts            tabs, settings panes, chat, permission cards
    permission-gate.ts     the permission pipeline and pending requests
    settings-store.ts      the per-workspace settings store
    storage-setups.ts      the built-in storage setups for the wizard dropdown
    storage-shares.ts      read-only storage sharing with the chat agent
    storage-migration.ts   moves legacy backends forward
    workspace-picker.ts    directory selection (dialog tool on Linux, NW input elsewhere)
    workspace-files.ts     folder inspection and the workspace marker
    workspace-migration.ts versioned workspace data migration
    window-geometry.ts     remembers the workspace window placement
    plugin-fields.ts       renders plugin UI definitions (fields as data)
    wizard.ts              the setup wizard screen
    notification-hub.ts    one hub for every notification
    doc-resources.ts       serves the harness documents on both surfaces
    json-viewer-element.ts collapsible JSON tree for tool results
    permission-request-element.ts  the approval card element
    node-context.ts        NW.js globals for the renderer: the app root path, the child_process slice
    file-system.ts         shared filesystem access: path join, directory list, text read, the fs slice
    dom.ts                 element lookup helper
    arguments.ts           command line arguments
  providers/       inference backends, one module per backend
    provider.ts       the InferenceProvider contract every backend implements
    openai.ts         OpenAI chat-completions endpoint (base URL plus API key)
    acp.ts            Agent Client Protocol agent (spawned process or WebSocket URL)
  storage/         storage backends, one module per backend
    storage.ts             the StorageBackend contract every backend implements
    node-access.ts         crypto and fs module loaders for the storage layer
    indexeddb.ts           IndexedDB key-value backend
    json-file.ts           JSON file backend with atomic writes
    password-encrypted.ts  password encryption wrapped over any backend
  plugins.ts       plugin manager: user-loaded providers and storage backends
scripts/           build helper scripts, plain Node ESM
tsconfig.json      solution root (project references)
tsconfig.base.json strict shared compiler options
tsconfig.shared.json    shared sources, compiled into dist/shared/
tsconfig.renderer.json  renderer sources; references shared, providers, storage
tsconfig.providers.json provider sources, compiled into dist/
tsconfig.storage.json   storage and plugin sources; references shared and providers
dist/              compiled output (gitignored)
```
