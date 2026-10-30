# Chat agent tools

The chat assistant is a tool-calling agent. A message may spend up to 12 provider turns on tool calls before it answers in text.

| Tool | Arguments | What it does |
|---|---|---|
| `evaluate` | `childId`, `expression` | The same evaluation the MCP host runs, as the `agent` principal: JavaScript in a child window. The first use on one window asks for approval. |
| `read` | `uri` | Reads one URI. See `harness:///nodewavenui/read-uris.md`. |
| `<label>.<tool>` | per the tool | Every MCP endpoint in Native mode contributes its tools under its sanitized label, for example `vault.search`. |

# Window tools

The agent carries the same window tools the MCP host serves: `list_windows`, `open_window`, `close_window`, `attach_session`, `detach_session`, `screenshot`, `console_entries`, `clear_console`, `navigate`, and `open_devtools`. The arguments match `harness:///nodewavenui/mcp-host-tools.md`. They act as the `agent` principal, so the mutating ones show the same approval cards in the chat. `screenshot` answers with a note instead of the image data, because the chat carries text only.

# Approval cards

Permission-gated actions (evaluate on a window, file reads) show an approval card above the chat input: Approve, Deny, and an Always checkbox that persists a rule. A request waits forever until answered.

# MCP endpoint modes

Each configured endpoint carries a mode, shown in the settings:

- **Native** — the tools join the agent tool list as `<label>.<tool>`.
- **Preloaded** — connected, but no tool joins the list. Reach it through `evaluate` and the `nodewavenMcp` page API.
- **None** — dormant until enabled at runtime: `nodewavenMcp.enable('<label>')` in an evaluation. The enable dies with the app run.
- **Disabled** — hidden from the agent; enable refuses it.

# Reading its own documentation

The agent reads these documents with the `read` tool under `harness:///nodewavenui/...`, the same documents the MCP host serves as resources.
