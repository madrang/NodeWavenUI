# The Graphs window

A child window that draws simple SVG graphs. It opens empty and carries the `nodewavenGraphs` page global. The colors come from the active app theme, so the API takes no color arguments.

# Open it

The page lives beside the workspace window page: `dist/renderer/graphs.html`. With the MCP host tools, build the URL from the tracked workspace window URL (`list_windows`) by replacing `main.html` with `graphs.html`, or pass the relative path `dist/renderer/graphs.html`:

1. `open_window` with the `graphs.html` URL.
2. `attach_session` on the returned child id.
3. `evaluate` calls that run `nodewavenGraphs` methods.

The chat agent carries the same window tools, so it opens the Graphs window, attaches a session, and draws through its `evaluate` on its own.

# API

Every drawing method replaces the current graph and answers with a confirmation string. An invalid spec throws with a message that names the problem. All numbers must be finite.

- `nodewavenGraphs.clear()` — empties the surface.
- `nodewavenGraphs.line({ title?, series })` — polylines. `series: [{ name?, points: [[x, y], ...] }]`.
- `nodewavenGraphs.scatter({ title?, series })` — point markers. Same shape as `line`.
- `nodewavenGraphs.bars({ title?, bars })` — vertical bars on a zero baseline. `bars: [{ label, value }]`.

Example: one line graph with two named series.

```js
nodewavenGraphs.line({ title: 'Latency', series: [
  { name: 'cache', points: [[0, 30], [1, 25], [2, 21], [3, 18]] },
  { name: 'cold', points: [[0, 120], [1, 90], [2, 70], [3, 55]] },
] })
```

A theme change in the app recolors a drawn graph at once. Up to six series or bars cycle their colors.
