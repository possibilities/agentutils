import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import {
  CONFIGURATION_DEMO_DESIGNS,
  ConfigurationPickerDemo,
} from "../src/tui/configuration-demo.js"
import { themeFor } from "../src/tui/theme.js"

test("demo treatments fill the width and reflow the Document when options open upward", async () => {
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
  const picker = new ConfigurationPickerDemo(setup.renderer, {
    theme,
    onRequestDocumentFocus: () => document.focus(),
  })
  root.add(document)
  root.add(picker)
  setup.renderer.root.add(root)

  try {
    await setup.renderOnce()
    for (const design of CONFIGURATION_DEMO_DESIGNS) {
      picker.setDesign(design)
      document.focus()
      await setup.renderOnce()
      const collapsedDocumentHeight = document.height
      expect(picker.width).toBe(80)
      expect(picker.modelButton.height).toBe(3)
      expect(picker.effortButton.height).toBe(3)
      expect(picker.modelButton.width + picker.effortButton.width).toBe(
        design === "stacked" ? 160 : 80,
      )

      await setup.mockMouse.click(picker.modelButton.screenX + 2, picker.modelButton.screenY + 1)
      await setup.renderOnce()
      expect(picker.activeField).toBe("model")
      expect(picker.menuVisible).toBe(true)
      expect(picker.optionCount).toBe(3)
      expect(picker.menuHeight).toBe(5)
      expect(document.height).toBe(collapsedDocumentHeight - 5)

      picker.closeAndFocusDocument()
      await setup.renderOnce()
      expect(document.height).toBe(collapsedDocumentHeight)
    }
  } finally {
    setup.renderer.destroy()
  }
})

test("demo controls and every option are clickable", async () => {
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
  const picker = new ConfigurationPickerDemo(setup.renderer, {
    theme,
    onRequestDocumentFocus: () => document.focus(),
    onConfigurationChange: (configuration) => changes.push(configuration),
  })
  const root = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  })
  root.add(document)
  root.add(picker)
  setup.renderer.root.add(root)

  try {
    await setup.renderOnce()
    await setup.mockMouse.click(picker.modelButton.screenX + 2, picker.modelButton.screenY + 1)
    await setup.renderOnce()
    const secondModel = picker.optionRow(1)
    expect(secondModel).not.toBeNull()
    await setup.mockMouse.click(secondModel!.screenX + 2, secondModel!.screenY)
    await setup.renderOnce()
    expect(picker.configuration.model).toBe("gpt-5.6-terra")
    expect(picker.menuVisible).toBe(false)
    expect(setup.renderer.currentFocusedRenderable).toBe(document)

    await setup.mockMouse.click(picker.effortButton.screenX + 2, picker.effortButton.screenY + 1)
    await setup.renderOnce()
    expect(picker.activeField).toBe("effort")
    expect(picker.optionCount).toBe(6)
    for (let index = 0; index < picker.optionCount; index += 1) {
      expect(picker.optionRow(index)?.visible).toBe(true)
    }
    const ultra = picker.optionRow(5)
    await setup.mockMouse.click(ultra!.screenX + 2, ultra!.screenY)
    await setup.renderOnce()
    expect(picker.configuration.effort).toBe("ultra")
    expect(changes).toHaveLength(2)
  } finally {
    setup.renderer.destroy()
  }
})
