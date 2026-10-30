# NodeWavenUI
A NW.js AI Workspace UI

## Status
One window with three screens: a launcher (folder selection), a setup wizard for new workspaces, and the main app (a settings tab plus chat tabs).
The chat runs through the configured OpenAI-compatible provider.

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

`npm start` returns while the app keeps running, because the `nw` launcher spawns the app and exits. Close the app window to exit. `chromium-args` in `package.json` routes `console.*` output to the terminal.

## Project layout

```
src/
  shared/          contracts that any module can import, free of platform dependencies
    workspace.ts     WorkspaceDirectory contract and its runtime guard
    nw.ts            declaration of the NW.js File.path addition
  renderer/        UI code (DOM context)
    index.html             the three app screens
    styles.css             system-color theme
    index.ts               screen controller (launcher, wizard, main)
    dom.ts                 element lookup helper
    node-context.ts        Node module access through the NW.js require global
    theme.ts               fallback theme: system guess plus a stored override
    window-geometry.ts     remembers the main app placement between sessions
    workspace-picker.ts    directory selection (dialog tool on Linux, NW input elsewhere)
    workspace-files.ts     folder inspection and the workspace marker
    settings-store.ts      the per-workspace settings store
    storage-setups.ts      the built-in storage setups for the wizard dropdown
    plugin-fields.ts       renders plugin UI definitions (fields as data)
    wizard.ts              the setup wizard screen
    main-app.ts            tabs, settings pane, and chat
  providers/       inference backends, one module per backend
    provider.ts       the InferenceProvider contract every backend implements
    openai.ts         OpenAI chat-completions endpoint (base URL plus API key)
    acp.ts            Agent Client Protocol agent (spawned process or WebSocket URL)
  storage/         storage backends, one module per backend
    storage.ts             the StorageBackend contract every backend implements
    node-access.ts         Node module access for the storage layer (crypto suites)
    indexeddb.ts           IndexedDB key-value backend
    password-encrypted.ts  password encryption wrapped over any backend
  plugins.ts       plugin manager: user-loaded providers and storage backends
scripts/           build helper scripts, plain Node ESM
tsconfig.json      solution root (project references)
tsconfig.base.json strict shared compiler options
tsconfig.renderer.json  renderer and shared sources, compiled into dist/
tsconfig.providers.json provider sources, compiled into dist/
tsconfig.storage.json   storage and plugin sources, compiled into dist/
dist/              compiled output (gitignored)
```

## Conventions
- Compiled TypeScript, no bundler. `tsc -b` emits one `.js` file and one `.d.ts` file per module. NW.js loads them as native ES modules.
- Each context gets its own tsconfig, listed in the root solution. `tsc -b` type-checks every referenced project.
- Validate values that do not come from the type system (DOM events, files) with runtime guards at module boundaries.
- Imports use explicit `.js` extensions.
- The app owns its theme palette. `theme.ts` applies the stored preference: system (the `prefers-color-scheme` media query), light, or dark. NW.js exposes no system-color API.
- Plugin UI is data: a plugin carries `PluginFieldDefinition` fields, `plugin-fields.ts` renders them, and `readConfiguration` validates the values. Every surface shows the same controls for the same plugin.
