# agenteditor

`agenteditor` is a bare OpenTUI text editor that a human and local agents can
edit together. The TUI renders only the Document; automation uses a guarded,
schema-versioned CLI instead of simulating keystrokes.

## Installation

`agenteditor` owns its fleet installation contract:

```sh
scripts/install.sh --install
```

This installs frozen dependencies, links `~/.local/bin/agenteditor` to this
checkout, and records the deployed Git SHA. AgentStart invokes the same
rerunnable installer during its normal full installation.

## Human use

```sh
agenteditor notes.md
```

The editor keeps familiar terminal and Readline editing behavior, including
arrows, selection, `ctrl+a/e/b/f`, `alt+b/f`, `ctrl+k/u/w`, `ctrl+y`, paste,
undo, and redo. `alt+x` opens the temporary command overlay. `ctrl+s` flushes
human input immediately and `ctrl+c` exits after flushing.

There is no standing UI around the text. Search, replace, go-to-line, Markdown
preview, history, and conflicts appear only while invoked.

## Agent use

Reads return a Revision. Every mutation of an existing Document must present
that Revision:

```sh
agenteditor read notes.md --json
agenteditor read notes.md --lines 20:80 --json
agenteditor search notes.md heading --json
agenteditor apply notes.md --base sha256:... --json < change.diff
agenteditor write notes.md --base sha256:... --json < replacement.md
agenteditor write notes.md --create --json < new.md
agenteditor status notes.md --json
agenteditor history notes.md --json
agenteditor undo notes.md --transaction tx_... --base sha256:... --json
agenteditor watch notes.md --after sha256:... --jsonl
```

`apply` accepts a unified diff for the one named Document. If a live human has
changed a disjoint range since `--base`, the Session rebases the Transaction.
An overlap returns `edit_conflict`; it never guesses. `write` is a complete
replacement and therefore conflicts with any intervening edit.

## Machine contract

With `--json`, commands produce one stdout envelope:

```json
{"schema_version":1,"ok":true,"error":null,"data":{}}
{"schema_version":1,"ok":false,"error":{"code":"stale_revision","message":"...","recovery":"..."},"data":null}
```

Exit `0` is success, `1` is a domain refusal with an envelope, and `2` is a
usage error on stderr. `watch --jsonl` emits one event object per line.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

The implementation pins `@opentui/core` to the version used by the fxnk style
viewer. Visual roles come from `~/code/fxnk/style/STYLE.md`: the terminal owns
its background; hierarchy uses the grayscale ramp and weight; focus and error
are the only UI hues; green and red are reserved for diff markers.
