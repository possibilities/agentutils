import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { CatalogModel } from "../src/catalog.js"
import { ConfigurationPanel } from "../src/tui/configuration.js"
import { DocumentTextarea } from "../src/tui/editor.js"
import { themeFor } from "../src/tui/theme.js"

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

test("outlined controls fill the width and open upward by reflowing the Document", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const theme = themeFor("dark")
  const root = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
  })
  const document = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: 0,
    flexGrow: 1,
    flexShrink: 1,
    focusable: true,
    backgroundColor: theme.background,
  })
  const panel = new ConfigurationPanel(setup.renderer, {
    theme,
    models: MODELS,
    onSelect: () => true,
    onRequestDocumentFocus: () => document.focus(),
    onQuit: () => {},
  })
  panel.setConfiguration("gpt-5.6-sol", "high")
  panel.resizeForSize(80, 24)
  root.add(document)
  root.add(panel)
  setup.renderer.root.add(root)

  try {
    document.focus()
    await setup.renderOnce()
    const collapsedDocumentHeight = document.height
    expect(panel.width).toBe(80)
    expect(panel.modelButton.height).toBe(3)
    expect(panel.effortButton.height).toBe(3)
    expect(panel.modelButton.width + panel.effortButton.width).toBe(80)
    expect(visibleText(setup)).not.toMatch(/send|submit|launch/iu)

    await setup.mockMouse.click(panel.modelButton.screenX + 2, panel.modelButton.screenY + 1)
    await setup.renderOnce()
    expect(panel.activeField).toBe("model")
    expect(panel.menuVisible).toBe(true)
    expect(panel.optionCount).toBe(3)
    expect(panel.menuHeight).toBe(5)
    expect(document.height).toBe(collapsedDocumentHeight - 5)
    expect(panel.optionRow(0)!.screenY).toBeLessThan(panel.modelButton.screenY)

    panel.closeAndFocusDocument()
    await setup.renderOnce()
    expect(document.height).toBe(collapsedDocumentHeight)
  } finally {
    setup.renderer.destroy()
  }
})

test("controls, options, keyboard selection, and exit remain directly operable", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const theme = themeFor("dark")
  const document = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: 0,
    flexGrow: 1,
    focusable: true,
    backgroundColor: theme.background,
  })
  const changes: Array<{ model: string; effort: string }> = []
  let quits = 0
  const panel = new ConfigurationPanel(setup.renderer, {
    theme,
    models: MODELS,
    onSelect: (configuration) => {
      changes.push(configuration)
      return true
    },
    onRequestDocumentFocus: () => document.focus(),
    onQuit: () => {
      quits += 1
    },
  })
  panel.setConfiguration("gpt-5.6-sol", "high")
  const root = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  })
  root.add(document)
  root.add(panel)
  setup.renderer.root.add(root)

  try {
    await setup.renderOnce()
    await setup.mockMouse.click(panel.modelButton.screenX + 2, panel.modelButton.screenY + 1)
    await setup.renderOnce()
    const secondModel = panel.optionRow(1)
    expect(secondModel).not.toBeNull()
    await setup.mockMouse.click(secondModel!.screenX + 2, secondModel!.screenY)
    await setup.renderOnce()
    expect(panel.configuration).toEqual({ model: "gpt-5.6-terra", effort: "medium" })
    expect(changes.at(-1)).toEqual({ model: "gpt-5.6-terra", effort: "medium" })
    expect(panel.menuVisible).toBe(false)
    expect(setup.renderer.currentFocusedRenderable).toBe(document)

    await setup.mockMouse.click(panel.modelButton.screenX + 2, panel.modelButton.screenY + 1)
    setup.mockInput.pressTab()
    await setup.flush()
    expect(panel.activeField).toBe("effort")
    expect(setup.renderer.currentFocusedRenderable).toBe(panel.effortButton)
    expect(panel.optionCount).toBe(6)

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(changes.at(-1)).toEqual({ model: "gpt-5.6-terra", effort: "high" })

    panel.focusModel()
    setup.mockInput.pressKey("m", { meta: true })
    await setup.flush()
    expect(panel.activeField).toBe("model")

    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.flush()
    expect(quits).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("Configuration focus is fxnk-styled and suppresses the Document cursor", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 12,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const theme = themeFor("dark")
  const root = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
  })
  const editor = new DocumentTextarea(setup.renderer, {
    id: "document",
    width: "100%",
    height: 0,
    flexGrow: 1,
    initialValue: "Document cursor",
    textColor: theme.primary,
    focusedTextColor: theme.primary,
    backgroundColor: theme.background,
    focusedBackgroundColor: theme.background,
  })
  const panel = new ConfigurationPanel(setup.renderer, {
    theme,
    models: MODELS,
    onSelect: () => true,
    onRequestDocumentFocus: () => editor.focus(),
    onQuit: () => {},
  })
  panel.setConfiguration("gpt-5.6-sol", "high")
  root.add(editor)
  root.add(panel)
  setup.renderer.root.add(root)

  try {
    editor.focus()
    await setup.renderOnce()
    expect(setup.renderer.getCursorState().visible).toBe(true)

    await setup.mockMouse.click(panel.modelButton.screenX + 2, panel.modelButton.screenY + 1)
    await setup.renderOnce()
    expect(setup.renderer.currentFocusedRenderable).toBe(panel.modelButton)
    expect(editor.showCursor).toBe(false)
    expect(setup.renderer.getCursorState().visible).toBe(false)

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const visibleSpans = spans.filter((span) => span.text.trim().length > 0)
    const chromatic = visibleSpans.filter((span) => !isGrayscale(span.fg))
    expect(chromatic.length).toBeGreaterThan(0)
    expect(chromatic.every((span) => span.fg.intent === "indexed" && span.fg.slot === 4)).toBe(true)
    expect(chromatic.every((span) => /^[┌─┐│└┘▎> ]+$/u.test(span.text))).toBe(true)
    expect(spans.every((span) => isGrayscale(span.bg))).toBe(true)

    const label = visibleSpans.find((span) => span.text.includes(" model "))
    expect(label?.fg.toInts()).toEqual(theme.secondary.toInts())
  } finally {
    setup.renderer.destroy()
  }
})

test("a shallow Surface keeps controls visible and scrolls a physically constrained menu", async () => {
  const setup = await createTestRenderer({
    width: 40,
    height: 6,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const theme = themeFor("dark")
  const document = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: 0,
    flexGrow: 1,
    focusable: true,
  })
  const changes: Array<{ model: string; effort: string }> = []
  const panel = new ConfigurationPanel(setup.renderer, {
    theme,
    models: MODELS,
    onSelect: (configuration) => {
      changes.push(configuration)
      return true
    },
    onRequestDocumentFocus: () => document.focus(),
    onQuit: () => {},
  })
  panel.setConfiguration("gpt-5.6-sol", "high")
  panel.resizeForSize(40, 6)
  const root = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  })
  root.add(document)
  root.add(panel)
  setup.renderer.root.add(root)

  try {
    await setup.renderOnce()
    panel.focusModel()
    await setup.renderOnce()
    expect(panel.height).toBe(6)
    expect(panel.menuHeight).toBe(3)
    expect(panel.optionRow(0)?.visible).toBe(true)
    expect(panel.optionRow(1)?.visible).toBe(false)
    expect(panel.modelButton.screenY + panel.modelButton.height).toBe(6)

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(changes.at(-1)).toEqual({ model: "gpt-5.6-luna", effort: "medium" })
  } finally {
    setup.renderer.destroy()
  }
})

function visibleText(setup: Awaited<ReturnType<typeof createTestRenderer>>): string {
  return setup.captureSpans().lines.flatMap((line) => line.spans.map((span) => span.text)).join("\n")
}

function isGrayscale(color: RGBA): boolean {
  const [red, green, blue] = color.toInts()
  return red === green && green === blue
}
