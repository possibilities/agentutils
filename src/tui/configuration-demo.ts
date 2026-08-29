import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  type KeyEvent,
} from "@opentui/core"
import type { CatalogModel } from "../catalog.js"
import { ConfigurationPanel } from "./configuration.js"
import { editorTheme, type EditorTheme } from "./theme.js"

const MODELS: CatalogModel[] = [
  {
    id: "gpt-5.6-sol",
    defaultEffort: "high",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-terra",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-luna",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
]

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
    height: 1,
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
      "Draft a prompt that asks an agent to review a release candidate. Ask it to inspect implementation, " +
      "tests, release notes, and operator behavior; identify regressions and missing verification; then report " +
      "findings with evidence. Distinguish confirmed failures from suspicions.\n\n" +
      "The selector menu below is a flyover, so opening it covers this Document without changing its layout. " +
      "The remaining Surface receives the same modal backdrop used by fmx. This longer sample exposes wrapping " +
      "and flyover coverage at narrow widths and shallow heights.",
    fg: theme.primary,
    bg: theme.background,
    selectable: false,
    wrapMode: "word",
  })
  document.add(documentText)

  let model = MODELS[0]!.id
  let effort = MODELS[0]!.defaultEffort!
  const panel = new ConfigurationPanel(renderer, {
    theme,
    models: MODELS,
    onSelect: (configuration) => {
      model = configuration.model
      effort = configuration.effort
      panel.setConfiguration(model, effort)
      return true
    },
    onRequestDocumentFocus: () => document.focus(),
    onQuit: resolveDone,
  })
  panel.setConfiguration(model, effort)
  panel.resizeForSize(renderer.width, renderer.height - 1)

  document.onMouseDown = (event) => {
    if (event.button !== 0) return
    panel.closeMenu()
    document.focus()
    event.preventDefault()
    event.stopPropagation()
  }
  const refreshHeader = (): void => {
    header.content = new StyledText([
      bold(fg(theme.primary)("outlined split")),
      fg(theme.dim)("  ·  click control/option  ·  esc closes  ·  ctrl+c exits"),
    ])
  }
  refreshHeader()

  root.add(header)
  root.add(document)
  root.add(panel)
  renderer.root.add(root)

  const keyHandler = (key: KeyEvent): void => {
    const name = key.name.toLowerCase()
    if (key.ctrl && name === "c") {
      key.preventDefault()
      key.stopPropagation()
      resolveDone()
    }
  }
  const resizeHandler = (): void => panel.resizeForSize(renderer.width, renderer.height - 1)
  const focusHandler = (focused: unknown): void => {
    if (focused === document) panel.closeMenu()
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
    panel.setTheme(next)
    refreshHeader()
  }

  renderer.keyInput.on("keypress", keyHandler)
  renderer.on("resize", resizeHandler)
  renderer.on("focused_renderable", focusHandler)
  themeController.start(applyTheme)
  renderer.start()
  panel.focusModel()
  await done

  renderer.keyInput.off("keypress", keyHandler)
  renderer.off("resize", resizeHandler)
  renderer.off("focused_renderable", focusHandler)
  themeController.dispose()
  renderer.destroy()
}

if (import.meta.main) {
  try {
    await runDemo()
  } catch {
    process.stderr.write("agentutils editor: unable to start the Configuration picker demo\n")
    process.exitCode = 1
  }
}
