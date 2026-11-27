# Chat agent tools

The chat assistant is a tool-calling agent. The workspace setting "Agent tool rounds" caps the provider rounds one message may spend on tool calls; the default is no limit. The workspace setting "Parallel task sessions" caps the task sessions that run at the same time; the default is no cap.

The user can stop a running turn at any time (Stop beside Send): the in-flight request aborts, the streamed partial stays, and a `Stopped.` notice lands. A message sent while a turn runs queues as a dimmed entry and delivers itself when the turn ends; a stop leaves the queue untouched. The Send now button of a queued entry hands the entry to the next step of the running turn.

| Tool | Arguments | What it does |
|---|---|---|
| `evaluate` | `pageId`, `expression` | The same evaluation the MCP host runs, as the `agent` principal: JavaScript in a page. The first use on one page asks for approval, unless its tool rule allows it. |
| `read` | `uri` | Reads one URI. See `harness:///nodewavenui/read-uris.md`. |
| `files` | `action`, `path`, `startLine`, `endLine`, `pattern`, `maxResults` | Reads and discovers files. `read` returns the whole file or one line range, `grep` scans a regular expression over a path subtree, and `list` returns one directory level. A relative path joins the workspace root. The Known paths rules decide which paths need a card. |
| `write` | `action`, `path`, `text`, `oldText`, `newText`, `all`, `line`, `before` | Proposes file changes as patches that wait for the user review. `write` proposes the whole file text, `replace` changes one passage, and `insert` adds lines at an anchor. Nothing lands on disk until the user approves. The chat must read an existing file before it changes the file. The reply names the patch id. |
| `tasks` | `action` and the arguments of the action | Manages the dispatchable task records of the workspace. See the Tasks section. |
| `<label>.<tool>` | per the tool | Every MCP endpoint in Native mode contributes its tools under its sanitized label, for example `vault.search`. The first call of each tool asks for approval. |

# Images

Each model in the settings carries a Vision flag: on when the model reads image parts. The flag decides what the chat does with pictures.

The user pastes or drops images into the chat: they arrive as thumbnails above the input, at most four per message, each scaled down to a 1280 pixel box. On a model without the flag, a send with images refuses: the chat shows a notice, and the text and the thumbnails stay ready. Tool image results — the `screenshot` page tool, or image content of native MCP tools — reach a flagged model as image parts of one follow-up message; a model without the flag reads an omission note in the tool result instead. Images ride again with every later request of the conversation, so they cost context tokens each turn.

# Page tools

The agent carries the same page tools the MCP host serves: `list_pages`, `open_uri`, `close_page`, `attach_session`, `detach_session`, `screenshot`, `console_entries`, `clear_console`, and `navigate`. The arguments match `harness:///nodewavenui/mcp-host-tools.md`. They act as the `agent` principal, so the mutating ones show the same approval cards in the chat. `screenshot` returns the image to a vision model as an image part; a text-only model reads the note in the result text.

# Command tools

The agent carries the same command tools the MCP host serves: `run`, `process_output`, and `process_stop`. A `run` call asks one card that parses the command into its stages: the program of each stage emphasized, the operators between stages, the redirects separated, and the expansions marked without resolving them. The raw command sits one line below, because the shell runs the command exactly as given and the parse serves display only. Evaluated code opens the DevTools of its own page with `nodewavenui.windows.openDevTools()` when the page holds the bridge: a repeated call changes nothing, and `toggleDevTools()` flips them both ways.

`open_uri` embeds a frame of the center workspace when its `kind` is `iframe` or `webview`. An `iframe` page loads app content but never attaches. A `webview` page runs its own guest process with its own debug target. An attach on a `webview` page that is not shared asks the user to share it: the approval turns the share switch on and covers the attach of that call, and a denial fails the attach.

# Tasks

The `tasks` tool manages the dispatchable task records of the workspace. A task is one unit of multi-part work. A chat session runs the task, and the user reviews the result on the task board.

- `name` titles the work of the chat. The title renames the tab, groups the patch events, and feeds the commit title.
- `create` starts a draft. Its arguments are `title`, `description`, `goal`, `goals`, `plan`, `parentTaskId`, `blockedBy`, `category`, `priority`, and the caps `maxTokens`, `maxTurns`, `timeLimitMs`. `maxTokens` takes 40000 or more, and `maxTurns` takes 4 or more. `template` copies a task template. `templates` lists the templates.
- `dispatch` binds a record to a chat session: a new one, or an existing one by `sessionFileId`. The dispatch asks one card, unless an allow rule governs the tool.
- `list` and `read` inspect the records. `list` narrows by `status` or `parentTaskId`. `read` with `part: "entries"` returns the transcript of the session of the task, with its errors and notices.
- `plan` replaces the steps of the plan of the task the session runs.
- `goals` replaces the checklist of a task.
- `prove` meets one goal of the checklist with its `proof` list. One item of the proof is a patch the session proposed (`kind: "patch"`, `id`), or a command the session ran to exit code zero (`kind: "command"`, `command`). The engine verifies each item. `complete` refuses while one goal stays open.
- `send` delivers one message into the session of a task. A busy session queues the message.
- `ask` puts a question to the operator. The task waits in `blocked` until the operator answers, and the answer arrives as the next message. While the task waits, the session offers no tool, so it can only close in text.
- `complete` and `fail` settle the work of the session agent.
- `wait` blocks until the task reaches `review`, `blocked`, or a terminal state.
- `cancel` stops a task. `reopen` returns a settled task to a draft, behind one card. `retry` returns a task that failed or ended by a limit, and the children it failed, to the queue, on a new session or on a session the call names, behind the same card.

Every action that names a task accepts its full id, or the short id that `list` prints.

The statuses, in life order, are `draft`, `queued`, `running`, `blocked`, `review`, `done`, `failed`, `exhausted`, `timeout`, and `cancelled`. `exhausted` means that a budget ran out. `timeout` means that the time limit passed.

Only the session that runs a task completes it, fails it, proves its goals, writes its plan, or asks for it. The session and the chat that created the task may send into the task, cancel it, reopen it, retry it, set its goals, and read its transcript.

A budget that runs low, or a time limit that passes, wraps the session up. The wrap-up keeps the `tasks`, `write`, and `files` tools. The task ends as `exhausted` or `timeout` unless the agent settles it. A turn that starts while the budget sits at its reserve runs as the wrap-up.

A round that the provider fails retries on the same connection. Then the session moves to the next connection of its chain. Each connection of the chain retries the same way. When nothing remains, the task fails by its provider.

A settle of a task reaches the chat that created the task, when that chat did not cause the settle.

# Approval cards

Permission-gated actions (evaluate on a page, file reads, native MCP tool calls) show an approval card above the chat input: Approve, Deny, and an Always checkbox that persists a rule. A request waits forever until answered.

# Tool rules

The settings pane carries an Agent tools section: one row per tool of the chat agent, with a three-state select.

- **Ask** — the permission pipeline decides, so a first use shows the approval card. This is the default.
- **Allow** — the calls of the tool run without the ask prompts of the file and page checks. A deny rule at those layers still blocks the call.
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
