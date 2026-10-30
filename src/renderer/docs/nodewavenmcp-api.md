# The nodewavenMcp page API

`nodewavenMcp` is a page global in the main window and in every child window. The functions run in the main context, so a call from child-window code reaches the full MCP client. Every method answers with a JSON string (or plain text for `read`), so the values cross window contexts safely.

Wrap the code in an async IIFE when you await: the evaluator has no top-level await.

```js
(async () => {
  const servers = JSON.parse(await nodewavenMcp.list());
  const reply = JSON.parse(await nodewavenMcp.call('Test Box', 'echo', { text: 'hello' }));
  return reply.text; // "echo: hello"
})()
```

## Methods

| Method | Arguments | Returns |
|---|---|---|
| `list()` | none | JSON array of the endpoint states: id, label, mode, state, error, toolNames, resourceUris. Disabled endpoints stay hidden. |
| `call(idOrLabel, tool, args)` | endpoint label or id, tool name, arguments object | JSON of `{ text, isError }`, or `{ error }` on failure. |
| `enable(idOrLabel)` | endpoint label or id | Connects a dormant (mode none) endpoint at runtime. JSON of the resulting state. |
| `disable(idOrLabel)` | endpoint label or id | Disconnects a runtime-enabled none-mode endpoint. |
| `resources(idOrLabel?)` | optional endpoint | JSON array of `{ label, resources }` for one or all connected endpoints. |
| `read(uri)` | one resource URI | The resource text, or `{ error }`. |
| `notify(...parts)` | notification content | Lands one user message in the chat: strings join, objects serialize. The chat agent sees it on its next turn. |
| `onNotification(method, callback)` | method name (`*` hears everything), callback `(method, params, source)` | JSON of `{ listenerId }`. The callback runs in the window that registered it. |
| `offNotification(listenerId)` | the id from onNotification | Removes the listener. |

## Notification sources the callbacks hear

- Notifications an external MCP client sends the host (`method` with no id in a POST).
- Notifications a remote MCP server sends the app, for example `notifications/message` or `notifications/tools/list_changed` (which also refreshes the tool list).

# Notes

- An endpoint in mode none stays dormant across launches: `enable` is runtime-only.
- An endpoint in mode disabled never appears, and `enable` refuses it.
- The calls carry no approval card of their own: the evaluate tool that reaches this API already passed the permission gate.
