# AgentUtils context

**AgentUtils** — A command suite whose focused utilities are selected by a
required subcommand. _Avoid_: agenteditor, editor app.

**Editor utility** — `agentutils editor`, the utility that owns the singleton
Surface and its MCP server. _Avoid_: agenteditor, editor process.

**Document** — UTF-8 text stored by the Editor utility under an opaque Document
ID. Agents may know its ID, title, content, and metadata, but never a filesystem
path. _Avoid_: file, buffer, file contents.

**Revision** — A `sha256:` content identity returned by every read and required
by every mutation. It is a concurrency precondition, not a sequence number.
_Avoid_: version, timestamp.

**Transaction** — One atomic change to a Document, attributed as `human` for
TUI input or `assistant` for MCP input. A Transaction may contain several
non-overlapping edits and is the unit of internal history and undo. _Avoid_:
command, write, patch.

**Surface** — The singleton live TUI and its MCP-visible state: focused
Document, Surface mode, and the focused Document's Configuration. _Avoid_:
session, daemon, editor process.

**Surface mode** — Which parts of the Surface are visible: `standby`,
`document`, `document_configuration`, or `configuration`. _Avoid_: screen,
layout preset.

**Configuration** — The model and reasoning effort selected for a Document
from the startup Catalog. It is inert state; the Editor utility never launches
an agent or submits a Document. _Avoid_: submission, launch request, agent.

**Catalog** — The immutable-for-the-process set of visible Codex models,
supported reasoning efforts, and defaults loaded once at startup. _Avoid_:
provider, registry.

**Active region** — The human selection, or current logical line after recent
input, that temporarily refuses overlapping assistant Transactions. _Avoid_:
ownership lock, checkout.
