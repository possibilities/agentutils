# AgentUtils

`agentutils` is a command suite for focused agent utilities. Its first utility,
`agentutils editor`, is a singleton collaborative Document Surface: a human
edits the focused Document in a bare OpenTUI interface while agents create,
resume, focus, read, and revise Documents through MCP.

The optional bottom panel stores a model and reasoning effort for the focused
Document. That state is intentionally inert. The Editor utility never sends a
prompt, launches an agent, or knows whether a Document will be used as a prompt.

## Connect an agent

Start the Surface first:

```sh
agentutils editor
```

It serves Streamable HTTP MCP at `http://127.0.0.1:7332/mcp`. For Codex, add:

```toml
[mcp_servers.agentutils_editor]
url = "http://127.0.0.1:7332/mcp"
required = true
```

The MCP server is part of the TUI process: if the Surface is not running, the
MCP server is not running. It binds only to IPv4 loopback and rejects unknown
Host and Origin values. The Editor utility has no path or control arguments
after its subcommand, and there is no Unix-socket automation surface.

## Core workflow

1. Call `create_document`, or call `list_documents` and `focus_document` to
   resume an existing one.
2. Read the returned Revision and content. Use `read_document` for a bounded
   line range when the Document is large.
3. Revise with `edit_document`. Send the Revision you read as
   `base_revision`; on a conflict, follow the returned recovery and reread.
4. Call `set_configuration` with a model/effort pair from `list_models`.
5. Immediately before an external launch, call `get_surface_state`. It returns
   one atomic snapshot containing the focused Document content, Revision,
   model, and effort.
6. Pass that snapshot to the separate tool that owns agent launch or prompt
   submission. Nothing in the Editor utility performs that final step.

MCP resource notifications can tell a client that state changed, but they do
not guarantee that a language model's context was refreshed. The explicit
`get_surface_state` call is the reliable handoff boundary.

## Resources

| URI | Contents |
| --- | --- |
| `agentutils://editor/surface` | Surface mode, focused Document metadata, Configuration, and Catalog status |
| `agentutils://editor/documents` | resumable Documents, newest first |
| `agentutils://editor/documents/{document_id}` | one Document's content, Revision, and Configuration |
| `agentutils://editor/models` | startup Catalog and supported effort values |

Clients that negotiate modern MCP resource-subscription capabilities may
subscribe to `surface` and individual Document resources. The server emits
resource-updated and resource-list-changed notifications after relevant
mutations. Legacy clients retain the complete tool and read-resource surface;
for every client, an explicit `get_surface_state` call remains authoritative.

## Tools

All tools return typed `structuredContent`. Domain refusals use stable error
codes and include current state plus a concrete recovery when available.

When a tool result has `isError: true`, inspect
`structuredContent.error.code` rather than parsing its message:

| Code | Meaning |
| --- | --- |
| `document_not_found` | The opaque ID is not resumable; list Documents again. |
| `no_focused_document` | The omitted `document_id` has no focused default. |
| `stale_revision` | The base snapshot is unavailable or a full replacement is stale. |
| `edit_target_not_found` | Exact target text was absent from the base Revision. |
| `ambiguous_edit` | Exact target text occurred more than once. |
| `edit_conflict` | Later work or the human Active region overlaps the Transaction. |
| `catalog_unavailable` | Startup model discovery failed; restart after Codex is available. |
| `invalid_configuration` | The model/effort pair is not in the startup Catalog. |
| `bad_request` / `internal_error` | Correct the request, or retry once and inspect the Surface. |

### `create_document`

Creates a private Document with an opaque generated ID.

```json
{"title":"Release prompt","content":"Draft the release notes.","focus":true}
```

`focus` defaults to `true`. New Documents receive the Catalog's default model
and effort when one is available.

### `list_documents`

Returns IDs, titles, Revisions, Configuration, and timestamps. Filesystem paths
do not exist anywhere in the MCP contract.

### `focus_document`

Focuses a Document by ID and restores its saved human cursor, selection, and
viewport. Focusing from standby reveals the Document.

### `read_document`

Reads all content or a one-based inclusive line range:

```json
{"document_id":"doc_…","lines":{"start":20,"end":80}}
```

Omit `document_id` to read the focused Document.

### `edit_document`

Applies one atomic list of exact-text operations against `base_revision`:

```json
{
  "document_id":"doc_…",
  "base_revision":"sha256:…",
  "edits":[
    {"kind":"replace","target":"old exact text","text":"new text"},
    {"kind":"insert_after","target":"## Constraints","text":"\n\nBe concise."},
    {"kind":"delete","target":"obsolete paragraph"}
  ]
}
```

`target` must be non-empty and occur exactly once in the base snapshot. Use
more surrounding text to disambiguate. `insert_before`, `insert_after`,
`replace`, and `delete` are supported; operations must not overlap. If human
work since the base Revision is disjoint, the Transaction rebases. Otherwise
the tool refuses rather than guessing.

### `replace_document`

Replaces the complete Document and therefore requires its current Revision.
This is useful for a new or short Document; iterative work should prefer
`edit_document` so disjoint human changes can survive.

### `set_surface_mode`

Selects `standby`, `document`, `document_configuration`, or `configuration`.
Every non-standby mode requires a focused Document.

### `list_models`

Returns the immutable startup Catalog. A model declares its supported efforts
and default effort.

### `set_configuration`

Atomically stores a valid model and supported effort on the focused or named
Document. Configuration follows the Document when another manager resumes it.

### `get_surface_state`

Returns the atomic external-handoff snapshot: mode, focused Document ID,
title, complete content, Revision, model, effort, and whether that combination
is valid in the startup Catalog. This tool is read-only and performs no launch
or submission.

## Collaboration rules

- Every change to existing Document content requires a Revision. There is no
  force or blind-overwrite path.
- Successful assistant mutations are committed to SQLite before MCP reports
  success.
- Disjoint changes may rebase; overlapping changes return `edit_conflict`.
- The human selection or recently edited logical line is an Active region.
  Assistant edits overlapping it are temporarily refused.
- Content mutations preserve the human cursor, selection, and viewport.
- Managers coordinate by focusing Documents. The product assumes one MCP
  manager is operating the singleton Surface at a time and has no lease API.

## Human Surface

The TUI normally contains only Document text. Agents control Configuration
visibility through `set_surface_mode`; there is no TUI shortcut for showing or
focusing it. When visible, two outlined three-row controls share the bottom of
the Surface. Clicking model or effort focuses it and opens a half-width option
list upward as one continuous outlined selector. Its quiet internal divider
replaces the button's top edge. The selector flies over the Document without
resizing it while the rest of the Surface sits under the same modal backdrop
used by fmx. Every option is clickable. Arrow keys move through options, Enter
chooses one, Tab changes field, and Escape returns to the Document.
Configuration contains no send control. The first `ctrl+c` shows a transient
exit notice; a second press within two seconds flushes and exits.

Human edits save automatically. A first launch with no focused Document shows
standby; MCP creation or focus supplies the work. The last focused Document,
mode, Configuration, and per-Document view state survive restart.

## Storage and privacy boundary

The Editor utility uses one private SQLite database. Its physical location is
an implementation detail and is never included in MCP data, errors, logs, or
resource URIs. There is no file import, path argument, legacy state migration,
or compatibility layer for an earlier CLI.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

The implementation pins OpenTUI and the official MCP SDK. Visual decisions
come only from `~/code/fxnk/style/STYLE.md` and `style/tokens.json`: fixed
dark/light grayscale ramps, terminal-owned background, and focus/error as the
only UI hues.
