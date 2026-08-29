import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  fg,
  type KeyEvent,
  type RenderContext,
  type Renderable,
} from "@opentui/core"
import type { CatalogModel, Configuration } from "../catalog.js"
import type { EditorTheme } from "./theme.js"

type ConfigurationField = "model" | "effort"

type ConfigurationPanelOptions = {
  theme: EditorTheme
  models: readonly CatalogModel[]
  onSelect: (configuration: { model: string; effort: string }) => boolean
  onQuit: () => void
  onRequestDocumentFocus: () => void
}

type OptionRow = {
  box: BoxRenderable
  text: TextRenderable
}

class ConfigurationButton extends BoxRenderable {
  private readonly text: TextRenderable
  private theme: EditorTheme

  constructor(
    ctx: RenderContext,
    readonly field: ConfigurationField,
    private readonly panel: ConfigurationPanel,
    theme: EditorTheme,
  ) {
    super(ctx, {
      id: `configuration-${field}`,
      width: "50%",
      height: 3,
      flexShrink: 0,
      border: true,
      borderColor: theme.divider,
      backgroundColor: theme.background,
      justifyContent: "center",
      shouldFill: true,
    })
    this.theme = theme
    this.text = new TextRenderable(ctx, {
      id: `configuration-${field}-value`,
      width: "100%",
      height: 1,
      content: "",
      fg: theme.primary,
      bg: theme.background,
      selectable: false,
      truncate: true,
    })
    this.add(this.text)
    this.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.panel.open(this.field)
      event.preventDefault()
      event.stopPropagation()
    }
    this.refresh()
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.borderColor = theme.divider
    this.backgroundColor = theme.background
    this.text.bg = theme.background
    this.refresh()
  }

  refresh(): void {
    if (this.text.isDestroyed) return
    const rawValue = this.panel.configuration[this.field] ?? "unavailable"
    const value = fitValue(rawValue, Math.max(1, this.width - this.field.length - 7))
    this.text.content = new StyledText([
      fg(this.theme.dim)(" "),
      fg(this.theme.secondary)(` ${this.field} `),
      fg(this.theme.primary)(value),
      fg(this.theme.dim)(" ▴"),
    ])
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.refresh()
  }
}

class ConfigurationSelector extends BoxRenderable {
  readonly menuRows: OptionRow[] = []
  readonly separator: TextRenderable
  private readonly buttonText: TextRenderable
  private readonly panel: ConfigurationPanel
  private theme: EditorTheme

  constructor(
    ctx: RenderContext,
    panel: ConfigurationPanel,
    theme: EditorTheme,
    maximumRows: number,
  ) {
    super(ctx, {
      id: "configuration-selector",
      position: "absolute",
      left: 0,
      bottom: 0,
      width: "50%",
      height: 4,
      flexDirection: "column",
      flexShrink: 0,
      border: true,
      borderColor: theme.divider,
      focusedBorderColor: theme.focus,
      backgroundColor: theme.background,
      focusable: true,
      shouldFill: true,
      zIndex: 3,
      visible: false,
    })
    this.panel = panel
    this.theme = theme

    for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
      const row = new BoxRenderable(ctx, {
        id: `configuration-option-${rowIndex}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        backgroundColor: theme.background,
        visible: false,
      })
      const text = new TextRenderable(ctx, {
        width: "100%",
        height: 1,
        content: "",
        fg: theme.secondary,
        bg: theme.background,
        selectable: false,
        truncate: true,
      })
      row.add(text)
      row.onMouseDown = (event) => {
        if (event.button !== 0 || !row.visible) return
        this.panel.chooseVisibleRow(rowIndex)
        event.preventDefault()
        event.stopPropagation()
      }
      this.add(row)
      this.menuRows.push({ box: row, text })
    }

    this.separator = new TextRenderable(ctx, {
      id: "configuration-selector-divider",
      width: "100%",
      height: 1,
      flexShrink: 0,
      content: "",
      fg: theme.divider,
      bg: theme.background,
      selectable: false,
      truncate: true,
    })
    this.buttonText = new TextRenderable(ctx, {
      id: "configuration-selector-value",
      width: "100%",
      height: 1,
      flexShrink: 0,
      content: "",
      fg: theme.primary,
      bg: theme.background,
      selectable: false,
      truncate: true,
    })
    this.add(this.separator)
    this.add(this.buttonText)
    this.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.focus()
      event.preventDefault()
      event.stopPropagation()
    }
  }

  override focus(): void {
    super.focus()
    this.refreshChrome()
  }

  override blur(): void {
    super.blur()
    this.refreshChrome()
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (key.ctrl && name === "c") {
      this.panel.quit()
      return true
    }
    if (name === "up" || name === "left") {
      this.panel.moveHighlight(-1)
      return true
    }
    if (name === "down" || name === "right") {
      this.panel.moveHighlight(1)
      return true
    }
    if (name === "return" || name === "enter") {
      this.panel.chooseHighlighted()
      return true
    }
    if (name === "escape") {
      this.panel.closeAndFocusDocument()
      return true
    }
    if (name === "tab") {
      this.panel.focusOther()
      return true
    }
    return false
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.backgroundColor = theme.background
    this.borderColor = theme.divider
    this.focusedBorderColor = theme.focus
    this.separator.fg = theme.divider
    this.separator.bg = theme.background
    this.buttonText.bg = theme.background
    for (const row of this.menuRows) {
      row.box.backgroundColor = theme.background
      row.text.bg = theme.background
    }
    this.refreshChrome()
  }

  refreshChrome(): void {
    if (this.buttonText.isDestroyed) return
    this.separator.content = "─".repeat(Math.max(0, this.width - 2))
    const field = this.panel.activeField
    if (field === null) {
      this.buttonText.content = ""
      return
    }
    const rawValue = this.panel.configuration[field] ?? "unavailable"
    const value = fitValue(rawValue, Math.max(1, this.width - field.length - 7))
    this.buttonText.content = new StyledText([
      fg(this.focused ? this.theme.focus : this.theme.dim)(this.focused ? "▎" : " "),
      fg(this.theme.secondary)(` ${field} `),
      this.focused ? bold(fg(this.theme.primary)(value)) : fg(this.theme.primary)(value),
      fg(this.theme.dim)(" ▴"),
    ])
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.refreshChrome()
  }
}

export class ConfigurationPanel extends BoxRenderable {
  readonly modelButton: ConfigurationButton
  readonly effortButton: ConfigurationButton
  readonly backdrop: BoxRenderable
  readonly selector: ConfigurationSelector
  private readonly controls: BoxRenderable
  private readonly visibleOptionIndices: number[] = []
  private readonly options: ConfigurationPanelOptions
  private theme: EditorTheme
  private value: Configuration = { model: null, effort: null }
  private active: ConfigurationField | null = null
  private highlighted = 0
  private scrollOffset = 0
  private maximumHeight: number
  private visibleMenuRows = 0

  constructor(ctx: RenderContext, options: ConfigurationPanelOptions) {
    super(ctx, {
      id: "configuration",
      width: "100%",
      height: 3,
      flexShrink: 0,
      backgroundColor: options.theme.background,
      overflow: "visible",
    })
    this.options = options
    this.theme = options.theme
    this.maximumHeight = Math.max(0, Math.trunc(ctx.height))

    this.backdrop = new BoxRenderable(ctx, {
      id: "configuration-backdrop",
      position: "absolute",
      left: 0,
      bottom: 0,
      width: "100%",
      height: this.maximumHeight,
      backgroundColor: options.theme.backdrop,
      shouldFill: true,
      zIndex: 1,
      visible: false,
    })
    this.backdrop.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.closeAndFocusDocument()
      event.preventDefault()
      event.stopPropagation()
    }

    this.controls = new BoxRenderable(ctx, {
      id: "configuration-controls",
      position: "absolute",
      left: 0,
      bottom: 0,
      width: "100%",
      height: 3,
      flexDirection: "row",
      backgroundColor: options.theme.background,
      zIndex: 2,
    })
    this.modelButton = new ConfigurationButton(ctx, "model", this, options.theme)
    this.effortButton = new ConfigurationButton(ctx, "effort", this, options.theme)
    this.controls.add(this.modelButton)
    this.controls.add(this.effortButton)

    const maximumRows = Math.max(
      options.models.length,
      0,
      ...options.models.map((model) => model.efforts.length),
    )
    this.selector = new ConfigurationSelector(ctx, this, options.theme, maximumRows)

    this.add(this.backdrop)
    this.add(this.controls)
    this.add(this.selector)
  }

  get activeField(): ConfigurationField | null {
    return this.active
  }

  get configuration(): Configuration {
    return { ...this.value }
  }

  get menuVisible(): boolean {
    return this.selector.visible && this.visibleMenuRows > 0
  }

  get optionCount(): number {
    return this.fieldOptions().length
  }

  get menuHeight(): number {
    return this.menuVisible ? this.visibleMenuRows + 1 : 0
  }

  get separator(): TextRenderable {
    return this.selector.separator
  }

  setConfiguration(model: string | null, effort: string | null): void {
    this.value = { model, effort }
    if (this.active !== null) {
      const selected = this.fieldOptions().indexOf(this.value[this.active] ?? "")
      this.highlighted = selected < 0 ? 0 : selected
    }
    this.refreshMenu()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.backgroundColor = theme.background
    this.backdrop.backgroundColor = theme.backdrop
    this.controls.backgroundColor = theme.background
    this.modelButton.setTheme(theme)
    this.effortButton.setTheme(theme)
    this.selector.setTheme(theme)
    this.refreshMenu()
  }

  resizeForSize(width: number, height: number): void {
    void width
    this.maximumHeight = Math.max(0, Math.trunc(height))
    this.backdrop.height = this.maximumHeight
    this.refreshMenu()
  }

  open(field: ConfigurationField): void {
    this.active = field
    const selected = this.fieldOptions().indexOf(this.value[field] ?? "")
    this.highlighted = selected < 0 ? 0 : selected
    this.scrollOffset = 0
    this.refreshMenu()
    if (this.selector.visible) this.selector.focus()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  closeMenu(): void {
    if (this.active === null && !this.selector.visible && !this.backdrop.visible) return
    if (this.selector.focused) this.selector.blur()
    this.active = null
    this.backdrop.visible = false
    this.selector.visible = false
    this.visibleMenuRows = 0
    this.visibleOptionIndices.length = 0
    this.refreshMenuRows([])
    this.selector.refreshChrome()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  closeAndFocusDocument(): void {
    this.closeMenu()
    this.options.onRequestDocumentFocus()
  }

  focusModel(): void {
    this.open("model")
  }

  focusOther(): void {
    this.open(this.active === "model" ? "effort" : "model")
  }

  ownsFocus(renderable: Renderable | null): boolean {
    return renderable === this.selector
  }

  releaseFocus(): void {
    if (this.selector.focused) this.selector.blur()
    this.closeMenu()
  }

  quit(): void {
    this.options.onQuit()
  }

  moveHighlight(delta: -1 | 1): void {
    const options = this.fieldOptions()
    if (options.length === 0) return
    this.highlighted = wrapIndex(this.highlighted + delta, options.length)
    this.refreshMenu()
  }

  chooseHighlighted(): void {
    this.choose(this.highlighted)
  }

  chooseVisibleRow(rowIndex: number): void {
    const optionIndex = this.visibleOptionIndices[rowIndex]
    if (optionIndex !== undefined) this.choose(optionIndex)
  }

  choose(index: number): void {
    const field = this.active
    const option = this.fieldOptions()[index]
    if (!field || option === undefined) return

    let next: { model: string; effort: string } | null = null
    if (field === "model") {
      const model = this.options.models.find((candidate) => candidate.id === option)
      const effort = model?.defaultEffort ?? model?.efforts[0]
      if (model && effort) next = { model: model.id, effort }
    } else if (this.value.model !== null) {
      next = { model: this.value.model, effort: option }
    }
    if (!next || !this.options.onSelect(next)) return

    this.value = next
    this.closeAndFocusDocument()
  }

  optionRow(rowIndex: number): BoxRenderable | null {
    return this.selector.menuRows[rowIndex]?.box ?? null
  }

  private fieldOptions(): readonly string[] {
    if (this.active === "model") return this.options.models.map((model) => model.id)
    if (this.active === "effort") {
      return this.options.models.find((model) => model.id === this.value.model)?.efforts ?? []
    }
    return []
  }

  private refreshMenu(): void {
    const options = this.fieldOptions()
    const rowCapacity = Math.max(0, this.maximumHeight - 4)
    this.visibleMenuRows = this.active === null ? 0 : Math.min(options.length, rowCapacity)
    const open = this.visibleMenuRows > 0 && this.active !== null
    this.backdrop.visible = open
    this.selector.visible = open

    if (!open) {
      this.visibleOptionIndices.length = 0
      this.refreshMenuRows([])
      this.selector.refreshChrome()
      return
    }

    const maximumOffset = Math.max(0, options.length - this.visibleMenuRows)
    if (this.highlighted < this.scrollOffset) this.scrollOffset = this.highlighted
    if (this.highlighted >= this.scrollOffset + this.visibleMenuRows) {
      this.scrollOffset = this.highlighted - this.visibleMenuRows + 1
    }
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset)
    const visible = options.slice(this.scrollOffset, this.scrollOffset + this.visibleMenuRows)
    this.visibleOptionIndices.length = 0
    for (let index = 0; index < visible.length; index += 1) {
      this.visibleOptionIndices.push(this.scrollOffset + index)
    }

    this.selector.left = this.active === "model" ? 0 : "50%"
    this.selector.height = this.visibleMenuRows + 4
    this.refreshMenuRows(visible)
    this.selector.refreshChrome()
  }

  private refreshMenuRows(visible: readonly string[]): void {
    for (const [rowIndex, row] of this.selector.menuRows.entries()) {
      const value = visible[rowIndex]
      row.box.visible = this.selector.visible && value !== undefined
      row.box.backgroundColor = this.theme.background
      row.text.bg = this.theme.background
      if (value === undefined) {
        row.text.content = ""
        continue
      }
      const optionIndex = this.visibleOptionIndices[rowIndex]
      const highlighted = optionIndex === this.highlighted
      row.text.content = new StyledText([
        fg(highlighted ? this.theme.focus : this.theme.dim)(highlighted ? "> " : "  "),
        highlighted ? bold(fg(this.theme.primary)(value)) : fg(this.theme.secondary)(value),
      ])
    }
  }
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length
}

function fitValue(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return "…"
  return `${value.slice(0, width - 1)}…`
}
