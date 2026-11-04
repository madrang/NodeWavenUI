# The app self test

The selftest plugin runs DOM specs inside the real NW.js engine, in a child window of the app. A plain browser is false ground truth for this app, so the DOM tier of the test suite runs where the app runs.

This document registers together with the plugin: it lists as a resource only while the plugin folder is enabled.

# Run it

1. Open the page as a child window: `plugins/selftest/specRunner.html`.
2. Attach a session to the child window.
3. Read the results: evaluate `nodewavenSelftest` on the page.

The page global holds `state` (`running` or `done`), the `passed`, `failed`, and `total` counts, and the `failures` array with the spec names and expectation messages. The specs start once the page globals settled, so give the page a few seconds after the open.

# What it covers

The suite verifies the environment the app pages run in: the NW.js globals, the EditContext API the Editor window builds on, the `nodewavenMcp` injection into child windows, and the plugin folder as a web root. The suite grows with the app.

The run is manual. The results live in the page only: no file, no automation, no launch flag.
