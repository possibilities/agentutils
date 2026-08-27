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
arrows, selection, `ctrl+a/e/b/f/n/p`, `alt+b/f`, `ctrl+k/u/w`,
`alt+d/backspace`, `ctrl+y`, transpose, paste, undo, and redo. Consecutive
kills accumulate in source order; at the end of a logical line, `ctrl+k`
kills its newline so the next line joins it. Human edits save automatically.
The first `ctrl+c` shows `press ctrl+c again to exit`; a second press within
two seconds flushes and exits.

There is no command palette, prompt, preview, manual save, or other interactive
mode. Apart from transient exit and save-failure notices, the TUI is only the
editable Document.

## Agent use

Reads return a Revision. Every mutation of an existing Document must present
that Revision:

```sh
agenteditor read notes.md --json
agenteditor read notes.md --lines 20:80 --json
agenteditor apply notes.md --base sha256:... --json < change.diff
agenteditor write notes.md --base sha256:... --json < replacement.md
agenteditor write notes.md --create --json < new.md
```

`apply` accepts a unified diff for the one named Document. If a live human has
changed a disjoint range since `--base`, the Session rebases the Transaction.
An overlap returns `edit_conflict`; it never guesses. `write` is a complete
replacement and therefore conflicts with any intervening edit. CLI
Transactions are attributed as `assistant`; TUI Transactions as `human`.

## Machine contract

With `--json`, commands produce one stdout envelope:

```json
{"schema_version":1,"ok":true,"error":null,"data":{}}
{"schema_version":1,"ok":false,"error":{"code":"stale_revision","message":"...","recovery":"..."},"data":null}
```

Exit `0` is success, `1` is a domain refusal with an envelope, and `2` is a
usage error on stderr.

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
