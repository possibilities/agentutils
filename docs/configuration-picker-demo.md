# Configuration picker demo

This development-only OpenTUI demo compares three treatments for the future
Configuration picker without changing the production Surface:

1. **Outlined split** — two three-row bordered controls share the width. It is
   the clearest select-box metaphor, but model names tighten at narrow widths.
2. **Filled split** — two three-row grayscale fields share the width with a
   focus caret instead of borders. It is quieter, but reads less literally as
   two buttons.
3. **Stacked outline** — two full-width three-row bordered controls stack. It
   preserves model names at narrow widths, at the cost of three more rows.

Every treatment opens one full-width option list immediately above the
controls. The list participates in flex layout, so it shortens the Document
instead of covering it. A control takes focus when clicked; every option is
also clickable. Arrow keys move the highlighted option, Enter chooses it, Tab
changes field, and Escape returns focus to the Document.

Run the demo from the repository:

```sh
bun run demo:configuration
```

Press `1`, `2`, or `3` to compare treatments. The demo has its own labels and
instructions; none are proposed for the production Surface.
