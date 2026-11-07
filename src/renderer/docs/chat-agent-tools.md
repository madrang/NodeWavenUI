# Chat agent tools

The chat assistant is a tool-calling agent. The workspace setting "Agent tool rounds" caps the provider rounds one message may spend on tool calls; the default is no limit.

The user can stop a running turn at any time (Stop beside Send): the in-flight request aborts, the streamed partial stays, and a `Stopped.` notice lands. A message sent while a turn runs queues as a dimmed entry and delivers itself when the turn ends; a stop leaves the queue untouched.

| Tool | Arguments | What it does |
|---|---|---|
| `evaluate` | `childId`, `expression` | The same evaluation the MCP host runs, as the `agent` principal: JavaScript in a child window. The first use on one window asks for approval, unless its tool rule allows it. |
| `read` | `uri` | Reads one URI. See `harness:///nodewavenui/read-uris.md`. |
| `<label>.<tool>` | per the tool | Every MCP endpoint in Native mode contributes its tools under its sanitized label, for example `vault.search`. The first call of each tool asks for approval. |

# Images

Each model in the settings carries a Vision flag: on when the model reads image parts. The flag decides what the chat does with pictures.

The user pastes or drops images into the chat: they arrive as thumbnails above the input, at most four per message, each scaled down to a 1280 pixel box. On a model without the flag, a send with images refuses: the chat shows a notice, and the text and the thumbnails stay ready. Tool image results — the `screenshot` window tool, or image content of native MCP tools — reach a flagged model as image parts of one follow-up message; a model without the flag reads an omission note in the tool result instead. Images ride again with every later request of the conversation, so they cost context tokens each turn.

# Window tools

The agent carries the same window tools the MCP host serves: `list_windows`, `open_window`, `open_frame`, `close_window`, `attach_session`, `detach_session`, `screenshot`, `console_entries`, `clear_console`, `navigate`, and `open_devtools`. The arguments match `harness:///nodewavenui/mcp-host-tools.md`. They act as the `agent` principal, so the mutating ones show the same approval cards in the chat. `screenshot` returns the image to a vision model as an image part; a text-only model reads the note in the result text.

`open_frame` embeds a frame beside the chat and settings panes. An `iframe` frame loads app content but never attaches. A `webview` frame runs its own guest process with its own debug target, and `attach_session` on it still fails while the user keeps the share switch of its title bar off.

# Approval cards

Permission-gated actions (evaluate on a window, file reads, native MCP tool calls) show an approval card above the chat input: Approve, Deny, and an Always checkbox that persists a rule. A request waits forever until answered.

# Tool rules

The settings pane carries an Agent tools section: one row per tool of the chat agent, with a three-state select.

- **Ask** — the permission pipeline decides, so a first use shows the approval card. This is the default.
- **Allow** — the calls of the tool run without the ask prompts of the file and window checks. A deny rule at those layers still blocks the call.
- **Disable** — the tool leaves the agent list, so the model never sees it.

The select writes a permission rule of resource `tool`, and the Always checkbox of an approval card writes the same rule shape, so the two controls stay in step. The read and evaluate built-ins start on Allow: a one-time seeding writes their rules, and a user who moves one back to Ask keeps that choice across launches.

# MCP endpoint modes

Each configured endpoint carries a mode, shown in the settings:

- **Native** — the tools join the agent tool list as `<label>.<tool>`.
- **Preloaded** — connected, but no tool joins the list. Reach it through `evaluate` and the `nodewavenMcp` page API.
- **None** — dormant until enabled at runtime: `nodewavenMcp.enable('<label>')` in an evaluation. The enable dies with the app run.
- **Disabled** — hidden from the agent; enable refuses it.

# Reading its own documentation

The agent reads these documents with the `read` tool under `harness:///nodewavenui/...`, the same documents the MCP host serves as resources.
