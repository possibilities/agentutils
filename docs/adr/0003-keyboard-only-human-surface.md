# 0003 — Direct human editing

Status: Amended. Historical interaction details below are superseded in the
scopes described by the dated amendments. The current interaction specification
lives in [README: Human Surface](../../README.md#human-surface).

## Decision retained

Humans edit the Document directly with automatic persistence. Agent mutations
use revision guards and preserve human view state; no palette, prompt workflow,
preview or manual-save workflow is added. This keeps the Surface focused on the
shared Document while an external manager owns launch and submission. The cost
is that visibility and automation belong to MCP and the manager, rather than a
second set of human controls. This rationale was captured retrospectively on
2026-09-08 from the current contract and the amendments below.

## Original record — 2026-08-27

The original filename is retained for stable links. Despite the former title
“Keyboard-only human surface,” the original body already included mouse editing.
Original text from commit `213ad33` follows; its CLI and exit comparisons are
historical, not additional current requirements.

Human interaction is direct keyboard and mouse editing with automatic persistence; the TUI has no palette, prompts, previews, or manual save. Exit matches fmx: one `ctrl+c` arms a two-second confirmation and a second press within that window flushes and exits, while agents retain only request-response, revision-guarded Document operations without search, undo, watch, or Proposal staging.

## Amendments — 2026-08-29

- `7754687` moved agent control to MCP, added Configuration selection and
  preserved the human cursor, selection and viewport during agent mutations.
  Explicit MCP focus restores each Document's saved view state. This changed
  the earlier request-response CLI boundary; see
  [0005: MCP-native agent boundary](0005-mcp-native-agent-boundary.md).
- `50ca740` removed the Configuration toggle/focus shortcut introduced above.
  Agents control Surface mode through MCP; there is no replacement TUI binding.
- `1abe20c` added the outlined click/keyboard Configuration picker; `f8630f8`
  changed its option list to a half-width flyover that does not resize the
  Document, with the rest of the Surface under the modal backdrop.

These are dated changes in the Git history, not new approvals inferred by this
record. On 2026-09-08, evolving affordance details were assigned to the existing
[Human Surface guide](../../README.md#human-surface); update that owner for current
interaction details and append an amendment or successor when a decision changes.
