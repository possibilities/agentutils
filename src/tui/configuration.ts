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
      focusable: true,
      border: true,
      borderColor: theme.divider,
      focusedBorderColor: theme.focus,
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
      this.focus()
      event.preventDefault()
      event.stopPropagation()
    }
    this.refresh()
  }

  override focus(): void {
    super.focus()
    this.panel.open(this.field)
    this.refresh()
  }

  override blur(): void {
    super.blur()
    this.refresh()
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
      this.panel.focusOther(this.field)
      return true
    }
    return false
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.borderColor = theme.divider
    this.focusedBorderColor = theme.focus
    this.backgroundColor = theme.background
    this.text.bg = theme.background
    this.refresh()
  }

  refresh(): void {
    if (this.text.isDestroyed) return
    const rawValue = this.panel.configuration[this.field] ?? "unavailable"
    const marker = this.focused ? "▎" : " "
    const value = fitValue(rawValue, Math.max(1, this.width - this.field.length - 7))
    this.text.content = new StyledText([
      fg(this.focused ? this.theme.focus : this.theme.dim)(marker),
      fg(this.theme.secondary)(` ${this.field} `),
      this.focused ? bold(fg(this.theme.primary)(value)) : fg(this.theme.primary)(value),
      fg(this.theme.dim)(" ▴"),
    ])
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.refresh()
  }
}

export class ConfigurationPanel extends BoxRenderable {
  readonly modelButton: ConfigurationButton
  readonly effortButton: ConfigurationButton
  private readonly menu: BoxRenderable
  private readonly controls: BoxRenderable
  private readonly menuRows: Array<{ box: BoxRenderable; text: TextRenderable }> = []
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
      flexDirection: "column",
      flexShrink: 0,
      backgroundColor: options.theme.background,
    })
    this.options = options
    this.theme = options.theme
    this.maximumHeight = Math.max(0, Math.trunc(ctx.height))

    this.menu = new BoxRenderable(ctx, {
      id: "configuration-menu",
      width: "100%",
      height: 0,
      flexDirection: "column",
      flexShrink: 0,
      border: true,
      borderColor: options.theme.divider,
      backgroundColor: options.theme.background,
      shouldFill: true,
      visible: false,
    })
    this.controls = new BoxRenderable(ctx, {
      id: "configuration-controls",
      width: "100%",
      height: 3,
      flexDirection: "row",
      flexShrink: 0,
      backgroundColor: options.theme.background,
    })
    this.modelButton = new ConfigurationButton(ctx, "model", this, options.theme)
    this.effortButton = new ConfigurationButton(ctx, "effort", this, options.theme)

    const maximumRows = Math.max(
      options.models.length,
      0,
      ...options.models.map((model) => model.efforts.length),
    )
    for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
      const row = new BoxRenderable(ctx, {
        id: `configuration-option-${rowIndex}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        backgroundColor: options.theme.background,
        visible: false,
      })
      const text = new TextRenderable(ctx, {
        width: "100%",
        height: 1,
        content: "",
        fg: options.theme.secondary,
        bg: options.theme.background,
        selectable: false,
        truncate: true,
      })
      row.add(text)
      row.onMouseDown = (event) => {
        if (event.button !== 0 || !row.visible) return
        const optionIndex = this.visibleOptionIndices[rowIndex]
        if (optionIndex !== undefined) this.choose(optionIndex)
        event.preventDefault()
        event.stopPropagation()
      }
      this.menu.add(row)
      this.menuRows.push({ box: row, text })
    }

    this.controls.add(this.modelButton)
    this.controls.add(this.effortButton)
    this.add(this.menu)
    this.add(this.controls)
  }

  get activeField(): ConfigurationField | null {
    return this.active
  }

  get configuration(): Configuration {
    return { ...this.value }
  }

  get menuVisible(): boolean {
    return this.menu.visible
  }

  get optionCount(): number {
    return this.fieldOptions().length
  }

  get menuHeight(): number {
    return this.menu.visible ? this.visibleMenuRows + 2 : 0
  }

  setConfiguration(model: string | null, effort: string | null): void {
    this.value = { model, effort }
    if (this.active !== null) {
      const selected = this.fieldOptions().indexOf(this.value[this.active] ?? "")
      this.highlighted = selected < 0 ? 0 : selected
    }
    this.refreshMenu()
    this.updateHeight()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.backgroundColor = theme.background
    this.controls.backgroundColor = theme.background
    this.menu.backgroundColor = theme.background
    this.menu.borderColor = theme.divider
    this.modelButton.setTheme(theme)
    this.effortButton.setTheme(theme)
    this.refreshMenu()
  }

  resizeForSize(width: number, height: number): void {
    void width
    this.maximumHeight = Math.max(0, Math.trunc(height))
    this.refreshMenu()
    this.updateHeight()
  }

  open(field: ConfigurationField): void {
    this.active = field
    const selected = this.fieldOptions().indexOf(this.value[field] ?? "")
    this.highlighted = selected < 0 ? 0 : selected
    this.scrollOffset = 0
    this.refreshMenu()
    this.updateHeight()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  closeMenu(): void {
    if (this.active === null && !this.menu.visible) return
    this.active = null
    this.menu.visible = false
    this.visibleMenuRows = 0
    this.visibleOptionIndices.length = 0
    this.refreshMenuRows([])
    this.updateHeight()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  closeAndFocusDocument(): void {
    this.closeMenu()
    this.options.onRequestDocumentFocus()
  }

  focusModel(): void {
    this.modelButton.focus()
  }

  focusOther(field: ConfigurationField): void {
    if (field === "model") this.effortButton.focus()
    else this.modelButton.focus()
  }

  ownsFocus(renderable: Renderable | null): boolean {
    return renderable === this.modelButton || renderable === this.effortButton
  }

  releaseFocus(): void {
    if (this.modelButton.focused) this.modelButton.blur()
    if (this.effortButton.focused) this.effortButton.blur()
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
    return this.menuRows[rowIndex]?.box ?? null
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
    const rowCapacity = Math.max(0, this.maximumHeight - 5)
    this.visibleMenuRows = this.active === null ? 0 : Math.min(options.length, rowCapacity)
    this.menu.visible = this.visibleMenuRows > 0
    this.menu.height = this.menuHeight

    if (this.visibleMenuRows === 0) {
      this.visibleOptionIndices.length = 0
      this.refreshMenuRows([])
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
    this.refreshMenuRows(visible)
  }

  private refreshMenuRows(visible: readonly string[]): void {
    for (const [rowIndex, row] of this.menuRows.entries()) {
      const value = visible[rowIndex]
      row.box.visible = this.menu.visible && value !== undefined
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

  private updateHeight(): void {
    this.height = 3 + this.menuHeight
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
