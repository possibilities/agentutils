# Configuration picker demo

This development-only OpenTUI demo exercises the production outlined-split
Configuration picker against a fixed sample Catalog. Two three-row bordered
controls share the full width. The sample Document is deliberately long enough
to expose wrapping and viewport pressure at narrow widths and shallow heights.

The full-width option list opens immediately above the controls and
participates in flex layout, so it shortens the Document instead of covering
it. A control takes focus when clicked; every option is also clickable. Arrow
keys move the highlighted option, Enter chooses it, Tab changes field, and
Escape returns focus to the Document.

Run the demo from the repository:

```sh
bun run demo:configuration
```

The demo's label and instructions are not proposed for the production Surface.
