import { describe, expect, test } from "bun:test"
import {
  EditorThemeController,
  colorFgBgIsLight,
  parseOsc11Theme,
  resolveTheme,
  themeFor,
  type ThemePort,
} from "../src/tui/theme.js"

describe("fxnk theme contract", () => {
  test("uses FX_THEME, one OSC 11 mode sample, COLORFGBG, then dark", async () => {
    const explicit = new FakeThemePort()
    expect(await resolveTheme(explicit, { FX_THEME: "LIGHT", COLORFGBG: "15;0" }, 1)).toEqual({
      mode: "light",
      source: "FX_THEME",
      explicit: true,
    })
    expect(explicit.writes).toEqual([])

    const sampled = new FakeThemePort("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
    expect(await resolveTheme(sampled, {}, 20)).toMatchObject({ mode: "light", source: "osc11" })
    expect(sampled.writes).toEqual(["\x1b]11;?\x1b\\"])

    expect(await resolveTheme(new FakeThemePort(), { COLORFGBG: "0;15" }, 1)).toMatchObject({
      mode: "light",
      source: "COLORFGBG",
    })
    expect(await resolveTheme(new FakeThemePort(), {}, 1)).toMatchObject({
      mode: "dark",
      source: "default",
    })
  })

  test("parses terminal backgrounds without deriving a palette", () => {
    expect(parseOsc11Theme("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe("dark")
    expect(parseOsc11Theme("\x1b]11;#ffffff\x07")).toBe("light")
    expect(parseOsc11Theme("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")).toBeNull()
    expect(colorFgBgIsLight("15;0")).toBe(false)
    expect(colorFgBgIsLight("0;15")).toBe(true)

    const grayscale = [
      ["dark", "primary", [238, 238, 238]],
      ["dark", "accent", [208, 208, 208]],
      ["dark", "secondary", [188, 188, 188]],
      ["dark", "dim", [138, 138, 138]],
      ["dark", "divider", [88, 88, 88]],
      ["dark", "surface", [48, 48, 48]],
      ["dark", "selectionBackground", [238, 238, 238]],
      ["dark", "selectionForeground", [38, 38, 38]],
      ["light", "primary", [38, 38, 38]],
      ["light", "accent", [68, 68, 68]],
      ["light", "secondary", [98, 98, 98]],
      ["light", "dim", [158, 158, 158]],
      ["light", "divider", [188, 188, 188]],
      ["light", "surface", [228, 228, 228]],
      ["light", "selectionBackground", [38, 38, 38]],
      ["light", "selectionForeground", [238, 238, 238]],
    ] as const
    for (const [mode, role, rgb] of grayscale) {
      const color = themeFor(mode)[role]
      expect(color.toInts().slice(0, 3)).toEqual([...rgb])
      expect(color.intent).toBe("rgb")
    }
    for (const mode of ["dark", "light"] as const) {
      expect(themeFor(mode).background.intent).toBe("default")
      expect(themeFor(mode).backdrop.toInts()).toEqual([0, 0, 0, 51])
      expect(themeFor(mode).focus).toMatchObject({ intent: "indexed", slot: 4 })
      expect(themeFor(mode).error).toMatchObject({ intent: "indexed", slot: 1 })
    }
  })

  test("restores the terminal-owned hardware cursor color", () => {
    const port = new FakeThemePort()
    const controller = new EditorThemeController(port, {
      mode: "dark",
      source: "default",
      explicit: false,
    })

    controller.restoreTerminalCursorColor()

    expect(port.writes).toEqual(["\x1b]12;default\x07\x1b]112\x07"])
  })

  test("retints the complete fixed theme after a fenced CSI 997 refresh", () => {
    const port = new FakeThemePort()
    const controller = new EditorThemeController(port, {
      mode: "dark",
      source: "default",
      explicit: false,
    })
    const changes: string[] = []
    controller.start((theme) => changes.push(theme.mode))

    expect(port.feedInput("\x1b[?997;2n")).toBe(true)
    expect(port.writes.at(-1)).toBe("\x1b[c")
    expect(port.feedInput("\x1b[?1;2c")).toBe(true)
    expect(port.writes.at(-1)).toBe("\x1b]11;?\x1b\\\x1b[c")
    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
    expect(port.feedInput("\x1b[?1;2c")).toBe(true)
    expect(changes).toEqual(["light"])
    expect(controller.current.mode).toBe("light")

    controller.dispose()
    expect(port.writes.at(-1)).toBe("\x1b[?2031l")
  })
})

class FakeThemePort implements ThemePort {
  readonly writes: string[] = []
  private readonly oscHandlers = new Set<(sequence: string) => void>()
  private readonly inputHandlers: Array<(sequence: string) => boolean> = []

  constructor(private readonly reply: string | null = null) {}

  write(sequence: string): void {
    this.writes.push(sequence)
    if (this.reply && sequence === "\x1b]11;?\x1b\\") {
      queueMicrotask(() => this.emitOsc(this.reply!))
    }
  }

  subscribeOsc(handler: (sequence: string) => void): () => void {
    this.oscHandlers.add(handler)
    return () => this.oscHandlers.delete(handler)
  }

  prependInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.unshift(handler)
  }

  removeInputHandler(handler: (sequence: string) => boolean): void {
    const index = this.inputHandlers.indexOf(handler)
    if (index >= 0) this.inputHandlers.splice(index, 1)
  }

  emitOsc(sequence: string): void {
    for (const handler of this.oscHandlers) handler(sequence)
  }

  feedInput(sequence: string): boolean {
    return this.inputHandlers.some((handler) => handler(sequence))
  }
}
