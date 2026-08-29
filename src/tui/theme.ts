import { RGBA, type CliRenderer } from "@opentui/core"

export type ThemeMode = "dark" | "light"

export type EditorTheme = {
  mode: ThemeMode
  background: RGBA
  primary: RGBA
  accent: RGBA
  secondary: RGBA
  dim: RGBA
  divider: RGBA
  surface: RGBA
  focus: RGBA
  error: RGBA
  selectionBackground: RGBA
  selectionForeground: RGBA
}

export type ThemeResolution = {
  mode: ThemeMode
  source: "FX_THEME" | "osc11" | "COLORFGBG" | "default"
  explicit: boolean
}

export type ThemePort = {
  write: (sequence: string) => unknown
  subscribeOsc: (handler: (sequence: string) => void) => () => void
  prependInputHandler: (handler: (sequence: string) => boolean) => void
  removeInputHandler: (handler: (sequence: string) => boolean) => void
}

const OSC11_QUERY = "\x1b]11;?\x1b\\"
const RESPONSE_FENCE_QUERY = "\x1b[c"
const ENABLE_THEME_NOTIFICATIONS = "\x1b[?2031h"
const DISABLE_THEME_NOTIFICATIONS = "\x1b[?2031l"
const DARK_NOTIFICATION = "\x1b[?997;1n"
const LIGHT_NOTIFICATION = "\x1b[?997;2n"
const OSC11_TIMEOUT_MS = 200
const RESTORE_TERMINAL_CURSOR_COLOR = "\x1b]12;default\x07\x1b]112\x07"

const THEMES: Readonly<Record<ThemeMode, EditorTheme>> = {
  dark: {
    mode: "dark",
    background: RGBA.defaultBackground(),
    primary: RGBA.fromHex("#eeeeee"),
    accent: RGBA.fromHex("#d0d0d0"),
    secondary: RGBA.fromHex("#bcbcbc"),
    dim: RGBA.fromHex("#8a8a8a"),
    divider: RGBA.fromHex("#585858"),
    surface: RGBA.fromHex("#303030"),
    focus: RGBA.fromIndex(4),
    error: RGBA.fromIndex(1),
    selectionBackground: RGBA.fromHex("#eeeeee"),
    selectionForeground: RGBA.fromHex("#262626"),
  },
  light: {
    mode: "light",
    background: RGBA.defaultBackground(),
    primary: RGBA.fromHex("#262626"),
    accent: RGBA.fromHex("#444444"),
    secondary: RGBA.fromHex("#626262"),
    dim: RGBA.fromHex("#9e9e9e"),
    divider: RGBA.fromHex("#bcbcbc"),
    surface: RGBA.fromHex("#e4e4e4"),
    focus: RGBA.fromIndex(4),
    error: RGBA.fromIndex(1),
    selectionBackground: RGBA.fromHex("#262626"),
    selectionForeground: RGBA.fromHex("#eeeeee"),
  },
}

export function themeFor(mode: ThemeMode): EditorTheme {
  return THEMES[mode]
}

export async function resolveTheme(
  port: Pick<ThemePort, "write" | "subscribeOsc">,
  environment: Record<string, string | undefined> = process.env,
  timeoutMs = OSC11_TIMEOUT_MS,
): Promise<ThemeResolution> {
  const explicit = explicitTheme(environment.FX_THEME)
  if (explicit) return { mode: explicit, source: "FX_THEME", explicit: true }

  const sampled = await queryOsc11(port, timeoutMs)
  if (sampled) return { mode: sampled, source: "osc11", explicit: false }

  if (colorFgBgIsLight(environment.COLORFGBG)) {
    return { mode: "light", source: "COLORFGBG", explicit: false }
  }
  return { mode: "dark", source: "default", explicit: false }
}

export class EditorThemeController {
  private monitor: LiveThemeMonitor | null = null

  constructor(
    private readonly port: ThemePort,
    private resolution: ThemeResolution,
  ) {}

  get current(): EditorTheme {
    return themeFor(this.resolution.mode)
  }

  start(onChange: (theme: EditorTheme) => void): void {
    if (this.monitor) return
    this.monitor = new LiveThemeMonitor(this.port, this.resolution, (resolution) => {
      this.resolution = resolution
      onChange(themeFor(resolution.mode))
    })
    this.monitor.start()
  }

  restoreTerminalCursorColor(): void {
    try {
      this.port.write(RESTORE_TERMINAL_CURSOR_COLOR)
    } catch {}
  }

  dispose(): void {
    this.monitor?.dispose()
    this.monitor = null
  }
}

export async function editorTheme(renderer: CliRenderer): Promise<EditorThemeController> {
  const port: ThemePort = {
    write: (sequence) => process.stdout.write(sequence),
    subscribeOsc: (handler) => renderer.subscribeOsc(handler),
    prependInputHandler: (handler) => renderer.prependInputHandler(handler),
    removeInputHandler: (handler) => renderer.removeInputHandler(handler),
  }
  return new EditorThemeController(port, await resolveTheme(port))
}

class LiveThemeMonitor {
  private phase: "idle" | "drain" | "sample" = "idle"
  private notification: ThemeMode | null = null
  private sample: ThemeMode | null = null
  private sampleDirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeOsc: (() => void) | null = null
  private disposed = false

  private readonly inputHandler = (sequence: string): boolean => {
    const notification = notificationTheme(sequence)
    if (notification) {
      if (this.current.explicit) return true
      this.notification = notification
      if (this.phase === "idle") this.beginDrain()
      else if (this.phase === "sample") this.sampleDirty = true
      return true
    }

    if (this.phase !== "idle" && isPrimaryDeviceAttributes(sequence)) {
      if (this.phase === "drain") this.beginSample()
      else this.finishSample()
      return true
    }
    return false
  }

  constructor(
    private readonly port: ThemePort,
    private current: ThemeResolution,
    private readonly onChange: (resolution: ThemeResolution) => void,
    private readonly timeoutMs = OSC11_TIMEOUT_MS,
  ) {}

  start(): void {
    if (this.disposed || this.unsubscribeOsc) return
    this.unsubscribeOsc = this.port.subscribeOsc((sequence) => {
      if (this.phase !== "sample") return
      const parsed = parseOsc11Theme(sequence)
      if (parsed) this.sample = parsed
    })
    this.port.prependInputHandler(this.inputHandler)
    this.tryWrite(ENABLE_THEME_NOTIFICATIONS)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.unsubscribeOsc?.()
    this.unsubscribeOsc = null
    this.port.removeInputHandler(this.inputHandler)
    this.tryWrite(DISABLE_THEME_NOTIFICATIONS)
  }

  private beginDrain(): void {
    this.phase = "drain"
    this.sample = null
    this.sampleDirty = false
    if (!this.tryWrite(RESPONSE_FENCE_QUERY)) this.finishWithNotification()
    else this.armTimeout()
  }

  private beginSample(): void {
    this.clearTimer()
    this.phase = "sample"
    this.sample = null
    this.sampleDirty = false
    if (!this.tryWrite(`${OSC11_QUERY}${RESPONSE_FENCE_QUERY}`)) this.finishWithNotification()
    else this.armTimeout()
  }

  private finishSample(): void {
    if (!this.sample) return
    if (this.sampleDirty) {
      this.phase = "idle"
      this.sample = null
      this.sampleDirty = false
      this.clearTimer()
      if (this.notification) this.beginDrain()
      return
    }

    const notification = this.notification
    const sample = this.sample
    this.resetCycle()
    if (!notification) return
    this.apply({ mode: sample, source: "osc11", explicit: false })
  }

  private finishWithNotification(): void {
    const notification = this.notification
    this.resetCycle()
    if (notification) this.apply({ mode: notification, source: "default", explicit: false })
  }

  private resetCycle(): void {
    this.phase = "idle"
    this.notification = null
    this.sample = null
    this.sampleDirty = false
    this.clearTimer()
  }

  private apply(next: ThemeResolution): void {
    if (next.mode === this.current.mode) return
    this.current = next
    this.onChange(next)
  }

  private armTimeout(): void {
    this.clearTimer()
    this.timer = setTimeout(() => this.finishWithNotification(), this.timeoutMs)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private tryWrite(sequence: string): boolean {
    try {
      this.port.write(sequence)
      return true
    } catch {
      return false
    }
  }
}

export function parseOsc11Theme(sequence: string): ThemeMode | null {
  const match = /^\x1b\]11;(?:rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})|#([0-9a-fA-F]{6}))(?:\x07|\x1b\\)$/u.exec(
    sequence,
  )
  if (!match) return null

  const components = match[4]
    ? [match[4].slice(0, 2), match[4].slice(2, 4), match[4].slice(4, 6)].map((part) => Number.parseInt(part, 16) * 257)
    : [match[1]!, match[2]!, match[3]!].map(normalizeOscComponent)
  if (components.some((component) => component === null)) return null
  const [red, green, blue] = components as [number, number, number]
  const luminance = Math.floor((red * 299 + green * 587 + blue * 114) / 1000)
  return luminance > 32_768 ? "light" : "dark"
}

export function colorFgBgIsLight(value: string | undefined): boolean {
  if (!value) return false
  const background = value.slice(value.lastIndexOf(";") + 1)
  if (!/^\d+$/u.test(background)) return false
  const index = Number.parseInt(background, 10)
  return index >= 8 && index <= 255
}

function explicitTheme(value: string | undefined): ThemeMode | null {
  if (value?.toLowerCase() === "light") return "light"
  if (value?.toLowerCase() === "dark") return "dark"
  return null
}

function queryOsc11(
  port: Pick<ThemePort, "write" | "subscribeOsc">,
  timeoutMs: number,
): Promise<ThemeMode | null> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = () => {}
    const finish = (mode: ThemeMode | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
      resolve(mode)
    }

    unsubscribe = port.subscribeOsc((sequence) => {
      const parsed = parseOsc11Theme(sequence)
      if (parsed) finish(parsed)
    })
    timer = setTimeout(() => finish(null), Math.max(0, timeoutMs))
    try {
      port.write(OSC11_QUERY)
    } catch {
      finish(null)
    }
  })
}

function normalizeOscComponent(component: string): number | null {
  const value = Number.parseInt(component, 16)
  if (!Number.isFinite(value)) return null
  const maximum = 2 ** (component.length * 4) - 1
  return Math.floor((value * 0xffff) / maximum)
}

function notificationTheme(sequence: string): ThemeMode | null {
  if (sequence === DARK_NOTIFICATION) return "dark"
  if (sequence === LIGHT_NOTIFICATION) return "light"
  return null
}

function isPrimaryDeviceAttributes(sequence: string): boolean {
  return /^\x1b\[\?[0-9]+(?:;[0-9]+)*c$/u.test(sequence)
}
