# NodeWavenUI agent overview

NodeWavenUI is an NW.js desktop app: one Chromium renderer with Node.js in one process. It tracks child windows you can inspect and drive, runs a chat agent with tools, and connects remote MCP servers.

# Surfaces

- **The MCP host.** An HTTP endpoint for external agents. It offers tools and resources (the documents you are reading now). The settings pane of the app shows the endpoint and the access token.
- **The chat agent.** The in-app assistant. It calls its own tools, and permission-gated actions show an approval card in the chat.
- **Child windows.** Pages the app opens and tracks. The `nodewavenMcp` page global is available in every child window and in the workspace window.

# Facts

- The workspace window hosts the MCP bridge. Never navigate it. Closing the workspace window closes every child window first, then the app.
- The host and the MCP client speak the legacy MCP era: the initialize handshake, protocol version 2025-06-18.
- Evaluated JavaScript runs through the Chromium debug protocol. A promise result is awaited, but top-level `await` does not exist: wrap the code in an async IIFE.

# Documents

- `harness:///nodewavenui/mcp-host-tools.md` — the MCP host tool reference
- `harness:///nodewavenui/chat-agent-tools.md` — the chat agent tools
- `harness:///nodewavenui/read-uris.md` — the read URI schemes
- `harness:///nodewavenui/nodewavenmcp-api.md` — the page API for evaluated code
- `harness:///nodewavenui/graphs.md` — the Graphs window and its drawing API
