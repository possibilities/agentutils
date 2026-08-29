# agenteditor agent guidance

Read `CONTEXT.md`, `README.md`, and the ADRs in `docs/adr/` before changing
the Surface or its MCP protocol.

## Product contract

- The live TUI is the focused Document plus an optional compact Configuration
  panel, either one alone, or standby. It has no persistent header, footer,
  filename, line-number gutter, status row, help text, or surrounding controls.
- The TUI has no command palette, prompts, preview, manual save, or submission
  affordance. Human interaction is keyboard/mouse Document editing,
  model/effort selection, `alt+m`, and a two-press `ctrl+c` exit; only transient
  exit and save-failure notices may cover the Document.
- Visual decisions come only from `~/code/fxnk/style/STYLE.md` and
  `~/code/fxnk/style/tokens.json`; no fleet-wide TUI convention applies.
- Human and agent mutations share one revisioned Document. Never add a blind
  overwrite or force path around the Revision precondition.
- Agent changes must not move the human cursor, selection, or viewport.
- A successful agent mutation is durable on disk. Conflicts are refusals with
  current state and a recovery, not best-effort merges.
- Agent automation exists only through the official MCP server. Keep tool and
  resource schemas typed, domain error codes stable, and filesystem paths out
  of every MCP result, error, notification, and URI.

## Development

Use Bun and the pinned OpenTUI version. Run:

```sh
bun test
bun run typecheck
bun run build
```

Installation changes must preserve the rerunnable, ownership-checking contract
in `scripts/install.sh`. Run the installer tests and a hermetic install before
changing AgentStart's fleet loop.

TUI changes also require real PTY verification and visual checks at 40, 80,
and 120 columns plus a shallow height. Reap every PTY session after testing.
