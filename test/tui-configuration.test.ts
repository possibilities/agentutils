import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { DocumentTextarea } from "../src/tui/editor.js"
import { ConfigurationPanel, configurationPanelHeight, configurationPanelText } from "../src/tui/surface.js"
import { themeFor } from "../src/tui/theme.js"

test("Configuration panel is compact, responsive, and has no submission affordance", () => {
  const wide = configurationPanelText({
    width: 80,
    model: "gpt-5.6-codex",
    effort: "high",
    selected: "model",
    focused: true,
  })
  expect(configurationPanelHeight(80)).toBe(1)
  expect(wide).toContain("▎ model  gpt-5.6-codex")
  expect(wide).toContain("effort  high")
  expect(wide).not.toContain("\n")

  const narrow = configurationPanelText({
    width: 40,
    model: "a-model-name-that-is-deliberately-longer-than-the-panel",
    effort: "medium",
    selected: "effort",
    focused: true,
  })
  expect(configurationPanelHeight(40)).toBe(2)
  expect(narrow.split("\n")).toHaveLength(2)
  expect(narrow.split("\n").every((line) => line.length <= 40)).toBe(true)
  expect(narrow).not.toMatch(/send|submit|launch/iu)
})

test("Tab selects a field and arrows cycle only that field", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 8,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const cycles: Array<{ field: "model" | "effort"; delta: -1 | 1 }> = []
  let quits = 0
  const panel = new ConfigurationPanel(setup.renderer, {
    theme: themeFor("dark"),
    onCycle: (field, delta) => cycles.push({ field, delta }),
    onQuit: () => {
      quits += 1
    },
  })
  panel.setConfiguration("gpt-5.6-codex", "medium")
  setup.renderer.root.add(panel)
  panel.focus()
  await setup.renderOnce()

  try {
    setup.mockInput.pressTab()
    await setup.flush()
    expect(panel.selectedField).toBe("effort")

    setup.mockInput.pressArrow("right")
    setup.mockInput.pressArrow("up")
    await setup.flush()
    expect(cycles).toEqual([
      { field: "effort", delta: 1 },
      { field: "effort", delta: -1 },
    ])

    setup.mockInput.pressKey("m", { meta: true })
    await setup.flush()
    expect(panel.selectedField).toBe("effort")
    expect(cycles).toHaveLength(2)

    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.flush()
    expect(quits).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("Configuration owns the only chromatic focus mark and suppresses the Document cursor", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 8,
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
    height: "100%",
    flexGrow: 1,
    initialValue: "Document cursor",
    textColor: theme.primary,
    focusedTextColor: theme.primary,
    backgroundColor: theme.background,
    focusedBackgroundColor: theme.background,
  })
  const panel = new ConfigurationPanel(setup.renderer, {
    theme,
    onCycle: () => {},
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

    panel.focus()
    await setup.renderOnce()
    expect(setup.renderer.currentFocusedRenderable).toBe(panel)
    expect(editor.showCursor).toBe(false)
    expect(setup.renderer.getCursorState().visible).toBe(false)

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const visibleSpans = spans.filter((span) => span.text.trim().length > 0)
    const chromatic = visibleSpans.filter((span) => !isGrayscale(span.fg))
    expect(chromatic.map((span) => span.text.trim())).toEqual(["▎"])
    expect(chromatic[0]?.fg).toMatchObject({ intent: "indexed", slot: 4 })
    expect(spans.every((span) => isGrayscale(span.bg))).toBe(true)

    const label = visibleSpans.find((span) => span.text.includes(" model  "))
    expect(label?.fg.toInts()).toEqual(theme.secondary.toInts())
  } finally {
    setup.renderer.destroy()
  }
})

function isGrayscale(color: RGBA): boolean {
  const [red, green, blue] = color.toInts()
  return red === green && green === blue
}
