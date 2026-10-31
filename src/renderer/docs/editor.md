# The Editor window

A child window with a plain-text editor. It builds on the EditContext API, so the native caret, the mouse selection, and input methods work. The page carries the `nodewavenEditor` page global. The colors come from the active app theme.

One document lives in one window. Open several windows when you need several documents.

# Open it

The page lives beside the workspace window page: `dist/renderer/editor.html`. With the MCP host tools, build the URL from the tracked workspace window URL (`list_windows`) by replacing `main.html` with `editor.html`, or pass the relative path `dist/renderer/editor.html`:

1. `open_window` with the `editor.html` URL.
2. `attach_session` on the returned child id.
3. `evaluate` calls that run `nodewavenEditor` methods.

The chat agent carries the same window tools, so it opens the Editor window, attaches a session, and edits through its `evaluate` on its own.

The user can type into the editor at any time. Read the text back with `getText` to see what the user changed.

# Offsets

Every offset counts UTF-16 code units from the start of the text. Offsets clamp into the text. A non-integer offset or a non-string argument throws with a message that names the problem.

# API

Every method answers with a confirmation string, except `getText` and `getSelection`.

- `nodewavenEditor.setText(text, { title? })` — replaces the whole document and sets an optional title. The undo history starts over.
- `nodewavenEditor.getText()` — answers with the whole text.
- `nodewavenEditor.replace(start, end, text)` — replaces one range, moves the caret behind the new text, and scrolls it into view.
- `nodewavenEditor.select(start, end)` — sets the selection, focuses the editor, and scrolls into view.
- `nodewavenEditor.getSelection()` — answers with `{ start, end }`.
- `nodewavenEditor.setTitle(title)` — sets the title bar and the window title. An empty string hides the bar.
- `nodewavenEditor.clear()` — empties the document and keeps the title.

Example: write a draft, then replace one range.

```js
nodewavenEditor.setText('draft v1\nsecond line', { title: 'draft.md' })
nodewavenEditor.replace(0, 8, 'final v2')
nodewavenEditor.getText()        // 'final v2\nsecond line'
nodewavenEditor.select(0, 8)
nodewavenEditor.getSelection()   // { start: 0, end: 8 }
```

# Undo

One undo history serves the user and the agent together. User typing, clipboard actions, and `replace` all step onto it. `setText` and `clear` empty it. The user steps back with Ctrl+Z and forward with Ctrl+Shift+Z or Ctrl+Y. The page keeps the last 100 steps.
