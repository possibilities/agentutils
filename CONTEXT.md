# agenteditor context

**Document** — The canonical-path text being edited, including the latest
in-memory human and agent mutations whether or not a TUI is attached.
_Avoid_: buffer, file contents.

**Revision** — A `sha256:` content identity returned by every read and required
by every mutation. It is a concurrency precondition, not a sequence number.
_Avoid_: version, timestamp.

**Transaction** — One atomic change to a Document, attributed as `human` for
TUI input or `assistant` for CLI input. A Transaction may contain several
non-overlapping edits and is the unit of internal history and undo.
_Avoid_: command, write, patch.

**Session** — The local single-writer coordinator held by an interactive TUI.
CLI clients connect to its private Unix socket; without one, a CLI mutation
holds the same Document lock for its duration.
_Avoid_: daemon, server.

**Active region** — The human selection, or current logical line after recent
input, that temporarily refuses overlapping agent Transactions.
_Avoid_: ownership lock, checkout.
