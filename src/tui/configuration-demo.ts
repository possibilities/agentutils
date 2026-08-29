import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import { editorTheme, type EditorTheme } from "./theme.js"

export const CONFIGURATION_DEMO_DESIGNS = ["outlined_split", "filled_split", "stacked"] as const
export type ConfigurationDemoDesign = (typeof CONFIGURATION_DEMO_DESIGNS)[number]
type ConfigurationField = "model" | "effort"

const MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const
const EFFORTS: Readonly<Record<(typeof MODELS)[number], readonly string[]>> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
}

const DESIGN_LABELS: Readonly<Record<ConfigurationDemoDesign, string>> = {
  outlined_split: "1 outlined split",
  filled_split: "2 filled split",
  stacked: "3 stacked outline",
}

type DemoConfiguration = {
  model: (typeof MODELS)[number]
  effort: string
}

type ConfigurationPickerDemoOptions = {
  theme: EditorTheme
  design?: ConfigurationDemoDesign
  onRequestDocumentFocus: () => void
  onConfigurationChange?: (configuration: DemoConfiguration) => void
}

class DemoSelectorButton extends BoxRenderable {
  private readonly text: TextRenderable
  private theme: EditorTheme
  private design: ConfigurationDemoDesign

  constructor(
    ctx: RenderContext,
    readonly field: ConfigurationField,
    private readonly picker: ConfigurationPickerDemo,
    theme: EditorTheme,
    design: ConfigurationDemoDesign,
  ) {
    super(ctx, {
      id: `configuration-demo-${field}`,
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
    this.design = design
    this.text = new TextRenderable(ctx, {
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
    this.applyDesign()
  }

  override focus(): void {
    super.focus()
    this.picker.open(this.field)
    this.refresh()
  }

  override blur(): void {
    super.blur()
    this.refresh()
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (name === "up" || name === "left") {
      this.picker.moveHighlight(-1)
      return true
    }
    if (name === "down" || name === "right") {
      this.picker.moveHighlight(1)
      return true
    }
    if (name === "return" || name === "enter") {
      this.picker.chooseHighlighted()
      return true
    }
    if (name === "escape") {
      this.picker.closeAndFocusDocument()
      return true
    }
    if (name === "tab") {
      this.picker.focusOther(this.field)
      return true
    }
    return false
  }

  setDesign(design: ConfigurationDemoDesign): void {
    this.design = design
    this.applyDesign()
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.borderColor = theme.divider
    this.focusedBorderColor = theme.focus
    this.applyDesign()
  }

  refresh(): void {
    if (this.text.isDestroyed) return
    const rawValue = this.picker.configuration[this.field]
    const marker = this.focused ? "▎" : " "
    if (this.design === "filled_split") {
      const value = fitValue(rawValue, Math.max(1, this.width - 2))
      this.text.content = new StyledText([
        fg(this.focused ? this.theme.focus : this.theme.dim)(`${marker} `),
        fg(this.theme.secondary)(this.field),
        fg(this.theme.dim)("  ▴\n  "),
        this.focused ? bold(fg(this.theme.primary)(value)) : fg(this.theme.primary)(value),
      ])
      return
    }

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

  private applyDesign(): void {
    const filled = this.design === "filled_split"
    this.border = !filled
    this.backgroundColor = filled ? this.theme.surface : this.theme.background
    this.text.bg = filled ? this.theme.surface : this.theme.background
    this.text.height = filled ? 2 : 1
    this.refresh()
  }
}

export class ConfigurationPickerDemo extends BoxRenderable {
  readonly modelButton: DemoSelectorButton
  readonly effortButton: DemoSelectorButton
  private readonly menu: BoxRenderable
  private readonly controls: BoxRenderable
  private readonly menuRows: Array<{ box: BoxRenderable; text: TextRenderable }> = []
  private readonly options: ConfigurationPickerDemoOptions
  private theme: EditorTheme
  private currentDesign: ConfigurationDemoDesign
  private active: ConfigurationField | null = null
  private highlighted = 0
  private value: DemoConfiguration = { model: MODELS[0], effort: EFFORTS[MODELS[0]][2]! }

  constructor(ctx: RenderContext, options: ConfigurationPickerDemoOptions) {
    const design = options.design ?? "outlined_split"
    super(ctx, {
      id: "configuration-picker-demo",
      width: "100%",
      height: controlsHeight(design),
      flexDirection: "column",
      flexShrink: 0,
      backgroundColor: options.theme.background,
    })
    this.options = options
    this.theme = options.theme
    this.currentDesign = design

    this.menu = new BoxRenderable(ctx, {
      id: "configuration-demo-menu",
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
      id: "configuration-demo-controls",
      width: "100%",
      height: controlsHeight(design),
      flexDirection: design === "stacked" ? "column" : "row",
      flexShrink: 0,
      backgroundColor: options.theme.background,
    })
    this.modelButton = new DemoSelectorButton(ctx, "model", this, options.theme, design)
    this.effortButton = new DemoSelectorButton(ctx, "effort", this, options.theme, design)

    const maximumRows = Math.max(MODELS.length, ...Object.values(EFFORTS).map((efforts) => efforts.length))
    for (let index = 0; index < maximumRows; index += 1) {
      const row = new BoxRenderable(ctx, {
        id: `configuration-demo-option-${index}`,
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
        this.choose(index)
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
    this.setDesign(design)
  }

  get design(): ConfigurationDemoDesign {
    return this.currentDesign
  }

  get activeField(): ConfigurationField | null {
    return this.active
  }

  get configuration(): DemoConfiguration {
    return { ...this.value }
  }

  get menuVisible(): boolean {
    return this.menu.visible
  }

  get optionCount(): number {
    return this.fieldOptions().length
  }

  get menuHeight(): number {
    return this.menu.visible ? this.fieldOptions().length + 2 : 0
  }

  setDesign(design: ConfigurationDemoDesign): void {
    this.currentDesign = design
    const stacked = design === "stacked"
    const height = controlsHeight(design)
    this.controls.flexDirection = stacked ? "column" : "row"
    this.controls.height = height
    this.modelButton.width = stacked ? "100%" : "50%"
    this.effortButton.width = stacked ? "100%" : "50%"
    this.modelButton.setDesign(design)
    this.effortButton.setDesign(design)
    this.updateHeight()
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

  open(field: ConfigurationField): void {
    this.active = field
    const selected = this.fieldOptions().indexOf(this.value[field])
    this.highlighted = selected < 0 ? 0 : selected
    this.menu.visible = true
    this.refreshMenu()
    this.updateHeight()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  close(): void {
    if (this.active === null && !this.menu.visible) return
    this.active = null
    this.menu.visible = false
    this.refreshMenu()
    this.updateHeight()
    this.modelButton.refresh()
    this.effortButton.refresh()
  }

  closeAndFocusDocument(): void {
    this.close()
    this.options.onRequestDocumentFocus()
  }

  focusOther(field: ConfigurationField): void {
    if (field === "model") this.effortButton.focus()
    else this.modelButton.focus()
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
    if (field === "model") {
      const model = option as DemoConfiguration["model"]
      this.value.model = model
      const supported = EFFORTS[model]
      if (!supported.includes(this.value.effort)) this.value.effort = supported[0]!
    } else this.value.effort = option
    this.options.onConfigurationChange?.(this.configuration)
    this.closeAndFocusDocument()
  }

  optionRow(index: number): BoxRenderable | null {
    return this.menuRows[index]?.box ?? null
  }

  private fieldOptions(): readonly string[] {
    if (this.active === "model") return MODELS
    if (this.active === "effort") return EFFORTS[this.value.model]
    return []
  }

  private refreshMenu(): void {
    const options = this.fieldOptions()
    this.menu.height = this.menuHeight
    for (const [index, row] of this.menuRows.entries()) {
      const value = options[index]
      row.box.visible = this.menu.visible && value !== undefined
      row.box.backgroundColor = this.theme.background
      row.text.bg = this.theme.background
      if (value === undefined) {
        row.text.content = ""
        continue
      }
      const highlighted = index === this.highlighted
      row.text.content = new StyledText([
        fg(highlighted ? this.theme.focus : this.theme.dim)(highlighted ? "> " : "  "),
        highlighted ? bold(fg(this.theme.primary)(value)) : fg(this.theme.secondary)(value),
      ])
    }
  }

  private updateHeight(): void {
    this.height = controlsHeight(this.currentDesign) + this.menuHeight
  }
}

export function configurationDemoLabel(design: ConfigurationDemoDesign): string {
  return DESIGN_LABELS[design]
}

function controlsHeight(design: ConfigurationDemoDesign): number {
  return design === "stacked" ? 6 : 3
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length
}

function fitValue(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

async function runDemo(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: true,
    useMouse: true,
    screenMode: "alternate-screen",
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  })
  const themeController = await editorTheme(renderer)
  let theme = themeController.current
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
  })
  const header = new TextRenderable(renderer, {
    width: "100%",
    height: 2,
    content: "",
    fg: theme.primary,
    bg: theme.background,
    selectable: false,
    truncate: true,
  })
  const document = new BoxRenderable(renderer, {
    id: "configuration-demo-document",
    width: "100%",
    height: 0,
    flexGrow: 1,
    flexShrink: 1,
    focusable: true,
    backgroundColor: theme.background,
  })
  const documentText = new TextRenderable(renderer, {
    width: "100%",
    height: "100%",
    content:
      "Draft a prompt that asks an agent to review a release candidate.\n\n" +
      "The selector menu below participates in layout, so this Document becomes shorter instead of being covered.",
    fg: theme.primary,
    bg: theme.background,
    selectable: false,
    wrapMode: "word",
  })
  document.add(documentText)
  const picker = new ConfigurationPickerDemo(renderer, {
    theme,
    onRequestDocumentFocus: () => document.focus(),
  })
  document.onMouseDown = (event) => {
    if (event.button !== 0) return
    picker.close()
    document.focus()
    event.preventDefault()
    event.stopPropagation()
  }
  const refreshHeader = (): void => {
    const labels = CONFIGURATION_DEMO_DESIGNS.map((design) =>
      design === picker.design
        ? bold(fg(theme.primary)(configurationDemoLabel(design)))
        : fg(theme.secondary)(configurationDemoLabel(design)),
    )
    const chunks = []
    for (const [index, label] of labels.entries()) {
      if (index > 0) chunks.push(fg(theme.dim)("  ·  "))
      chunks.push(label)
    }
    chunks.push(fg(theme.dim)("\nclick control/option  ·  1/2/3 design  ·  esc closes  ·  ctrl+c exits"))
    header.content = new StyledText(chunks)
  }
  refreshHeader()

  root.add(header)
  root.add(document)
  root.add(picker)
  renderer.root.add(root)

  const keyHandler = (key: KeyEvent): void => {
    const name = key.name.toLowerCase()
    if (key.ctrl && name === "c") {
      key.preventDefault()
      key.stopPropagation()
      resolveDone()
      return
    }
    const design =
      name === "1"
        ? CONFIGURATION_DEMO_DESIGNS[0]
        : name === "2"
          ? CONFIGURATION_DEMO_DESIGNS[1]
          : name === "3"
            ? CONFIGURATION_DEMO_DESIGNS[2]
            : null
    if (!design) return
    key.preventDefault()
    key.stopPropagation()
    picker.setDesign(design)
    refreshHeader()
  }
  const applyTheme = (next: EditorTheme): void => {
    theme = next
    renderer.setBackgroundColor(next.background)
    root.backgroundColor = next.background
    header.fg = next.primary
    header.bg = next.background
    document.backgroundColor = next.background
    documentText.fg = next.primary
    documentText.bg = next.background
    picker.setTheme(next)
    refreshHeader()
  }

  renderer.keyInput.on("keypress", keyHandler)
  themeController.start(applyTheme)
  renderer.start()
  picker.modelButton.focus()
  await done

  renderer.keyInput.off("keypress", keyHandler)
  themeController.dispose()
  renderer.destroy()
}

if (import.meta.main) {
  try {
    await runDemo()
  } catch {
    process.stderr.write("agenteditor: unable to start the Configuration picker demo\n")
    process.exitCode = 1
  }
}
