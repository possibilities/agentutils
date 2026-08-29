# Configuration picker demo

This development-only OpenTUI demo exercises the production outlined-split
Configuration picker against a fixed sample Catalog. Two three-row bordered
controls share the full width. The sample Document is deliberately long enough
to expose wrapping and flyover coverage at narrow widths and shallow heights.

The active option list opens immediately above its half-width control as one
continuous flyover. A dim internal divider separates options from the control.
The flyover covers the Document without resizing it, while the remaining
Surface receives fmx's modal backdrop. A control takes focus when clicked;
every option is also clickable. Arrow keys move the highlighted option, Enter
chooses it, Tab changes field, and Escape returns focus to the Document.

Run the demo from the repository:

```sh
bun run demo:configuration
```

The demo's label and instructions are not proposed for the production Surface.
