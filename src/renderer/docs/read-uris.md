# The read URI schemes

The `read` tool dispatches on the URI scheme. The scheme names the provider, per the MCP resource model.

## harness:

`harness:///nodewavenui/<document>.md` reads the documentation of the app itself. A folder URI with its trailing slash, like `harness:///nodewavenui/`, lists the documents and subfolders under it the same way.

- `harness:///nodewavenui/overview.md`
- `harness:///nodewavenui/mcp-host-tools.md`
- `harness:///nodewavenui/chat-agent-tools.md`
- `harness:///nodewavenui/read-uris.md`
- `harness:///nodewavenui/nodewavenmcp-api.md`
- `harness:///nodewavenui/graphs.md`
- `harness:///nodewavenui/editor.md`
- `harness:///nodewavenui/project-layout.md`

`harness:///nodewavenui/known-paths.md` carries no file: it lists the registered path rules with their names, modes, and meanings, rendered from the live settings.

## file:

`file:///absolute/path` reads one file. A path inside the workspace follows the Known paths rules: an unregistered path asks one card on first read, and a deny rule refuses it. A path outside the workspace asks one card on every read.

## storage:

`storage://<storageId>/<key>` reads one record of a storage the user shared read-only in the settings. A storage that is not shared is refused with the list of the ids that are shared. The settings storage of the workspace is not shared by default; when the user shares it, its id is the backend id (for example `json-file`).

## Every other scheme

The URI goes to the connected MCP server that lists the resource or claims the scheme (its `resources/read`). No approval card shows: the user configured the endpoint.

# Errors

Every refusal names the reason and, for storage, the shared ids, so a caller can self-correct the URI.
