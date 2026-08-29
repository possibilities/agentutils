import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
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
  let toggles = 0
  let quits = 0
  const panel = new ConfigurationPanel(setup.renderer, {
    theme: themeFor("dark"),
    onCycle: (field, delta) => cycles.push({ field, delta }),
    onToggle: () => {
      toggles += 1
    },
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
    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.flush()
    expect(toggles).toBe(1)
    expect(quits).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})
