# Project layout

Where everything lives in the NodeWavenUI source tree. `tsc -b` compiles the sources into `dist/`, and the renderer assets (HTML, CSS, these documents) copy alongside.

```
src/
  shared/          contracts and small platform wrappers that every compile context shares
    workspace.ts     workspace directory and settings contracts with runtime guards
    permissions.ts   the principal kinds and permission targets
    mcp-endpoints.ts the stored MCP endpoint list contract
    bridge.ts        the nodewavenui bridge contract: fs, app facts, window calls, workspace services
    window-tools.ts  the page tool definitions the MCP host and the chat agent share
    core-api.ts      the background core contract: request channels, events, chat wire shapes, worker-to-main calls
    harness-docs.ts  the harness document table and readers (the pages fetch a document, the worker reads it from disk)
    system-prompts.ts the system prompt sources and the menu helpers: the built-in sources, the prompt files of the instructions folder, the selector slots
    workspace-migration.ts the version compare of the workspace data migration: each step range against the loaded version and the running version
    node-access.ts   the page-context require wrapper (plugin and crypto loaders)
    records.ts       record guards for untyped boundary values (isRecord, asRecord)
  renderer/        UI code (DOM context)
    index.html             the launcher and setup wizard window
    main.html              the workspace window (settings and chat panes)
    graphs.html            the Graphs window, an SVG drawing surface
    editor.html            the Editor window, a plain-text editor on the EditContext API
    base.css               shared primitives of every screen: resets, metrics, controls, status text
    launcher.css           the launcher and wizard chrome (fixed palette, no theme)
    workspace.css          the workspace screen: top bar, panes, rail, chat column, frame views
    settings.css           the settings pane: known paths, endpoints, plugin folders, provider cards
                           themes/ holds one palette file per theme
    docs/                  harness documents served to agents as MCP resources
    index.ts               launcher window: folder selection, unlock, wizard
    main-window.ts         opens the workspace window with the stored frame mode
    main-handoff.ts        the startup payload the launcher hands to the workspace window
    main.ts                workspace window boot: storage, the data version stamp of the marker once the core is ready, the bridge routes, the MCP host start
    frame-mode.ts          the system-border / borderless registry
    theme.ts               theme discovery (built-in and app-root themes/ folders); mirrors the applied id for app pages
    graphs.ts              the Graphs window page and the nodewavenGraphs page global
    edit-context.ts        EditContext API type declarations (the DOM library predates the API)
    editor.ts              the Editor window page and the nodewavenEditor page global
    mcp-client-adapter.ts  the MCP client surface over the bridge (states cached, calls forwarded)
    main-app.ts            tabs, composer, streaming render, permission cards; renders the chats the worker core owns
    chat-client.ts         the chat mirror of the page: applies the chat events of the core, sends the chat actions
    settings.ts            the settings pane of the workspace: providers, endpoints, shares, paths, preferences
    chat-render.ts         the chat model and the message list: bubbles, tool cards, agent turn rails
    permission-gate.ts     the gate client of the page over the core permission channels
    chat-sessions.ts       the entry and session types the views read; the sessions persist in the worker core
    system-prompts.ts      registers the built-in sources of the chat menu, and lists the prompt files of the instructions folder
    plugin-folders.ts      the plugins/ folder scan, the manifest guard, the SHA-256 integrity gate, and the settings controller
    frames.ts              the embedded frame tiling manager: iframe and webview panels beside the panes, with their title bars and the webview share switch
    storage-setups.ts      the built-in storage setups for the wizard dropdown
    storage-migration.ts   moves legacy backends forward
    workspace-picker.ts    directory selection through the native dialog of the main process
    workspace-files.ts     folder inspection and the workspace marker
    workspace-migration.ts launcher stage of the workspace data migration, at workspace open: the step from 0.3 to 0.4 moves AGENTS.md into instructions/
    window-geometry.ts     remembers the workspace window placement
    plugin-fields.ts       renders plugin UI definitions (fields as data)
    plugins.ts             plugin manager: user-loaded providers and storage backends
    wizard.ts              the setup wizard screen
    notification-hub.ts    one hub for every notification
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
    worker-service.ts      the worker link: forks the core, relays core requests, answers the calls the core sends
    tool-runner.ts         the chat agent tool calls of main, for the page ipc handler and the calls of the core
    diagnostics.ts         the renderer console relay (--verbose mirrors every line)
  worker/          the background core, one utility process per open workspace
    worker.ts             the core entry: opens the storage and the stores, serves the core contract
    chat-engine.ts        the chats, the agent turn loop, the provider calls, and the task sessions
    agent-tools.ts        the chat agent tool registry: built-ins, file and task tools, main-process tools, native tools
    file-tools.ts         the files and write tools over the worker fs and the patch store
    task-tools.ts         the tasks tool over the task store and the sessions of the engine
    permission-gate.ts    the permission queue and the rules
    patch-store.ts        the patch records and the tasks that group them
    task-store.ts         the dispatchable task records
    chat-sessions.ts      the chat session files, sealed with a storage-held chat key on password workspaces
    workspace-migration.ts core stage of the workspace data migration, at core boot before the first session read: the step from 0.4 to 0.5 rewrites the bound prompt of the session files
    remote-server.ts      the remote control server of the phone page
    system-prompts.ts     the built-in sources of the engine, and the lister of the prompt files of the instructions folder
    node-file-system.ts   shared filesystem access over node:fs
    node-fs.ts            the fs slice of the JSON file backend in the worker
    logger.ts             the worker logging bootstrap, forwarding to the main process
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
    guarded.ts             the guarded storage wrapper for one principal
    shared-storages.ts     the storage sharing record and its guard
    share-registry.ts      the shared storages of the chat agent, each behind the guarded wrapper
    settings-store.ts      the per-workspace settings records
scripts/           build helper scripts, plain Node ESM
tsconfig.json      solution root (project references)
tsconfig.base.json strict shared compiler options
tsconfig.main.json      main process sources, compiled into dist/main/; references shared
tsconfig.shared.json    shared sources, compiled into dist/shared/
tsconfig.renderer.json  renderer sources; references shared, providers, storage
tsconfig.providers.json provider sources, compiled into dist/
tsconfig.storage.json   storage sources; references shared and providers
tsconfig.worker.json    worker sources, compiled into dist/worker/; references shared, providers, storage
eslint.config.mjs ESLint flat config: typescript-eslint recommended plus the stylistic format
dist/              compiled output (gitignored)
```
