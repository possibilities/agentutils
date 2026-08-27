# agenteditor agent guidance

Read `CONTEXT.md`, `README.md`, and the ADRs in `docs/adr/` before changing
the editor or its CLI protocol.

## Product contract

- The live TUI is only the document. It has no persistent header, footer,
  filename, line-number gutter, status row, help text, or surrounding controls.
- The TUI has no command palette, prompts, preview, or manual save. Human
  interaction is keyboard/mouse editing plus a two-press `ctrl+c` exit; only
  transient exit and save-failure notices may cover the Document.
- Visual decisions come only from `~/code/fxnk/style/STYLE.md` and
  `~/code/fxnk/style/tokens.json`; no fleet-wide TUI convention applies.
- Human and agent mutations share one revisioned Document. Never add a blind
  overwrite or force path around the Revision precondition.
- Agent changes must not move the human cursor, selection, or viewport.
- A successful agent mutation is durable on disk. Conflicts are refusals with
  current state and a recovery, not best-effort merges.
- Machine output uses the schema-versioned JSON envelope described in the
  README. Keep stdout parseable and errors stable.

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
