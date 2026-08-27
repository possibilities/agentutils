import type { CliRenderer } from "@opentui/core"

export type EditorTheme = {
  background: string
  primary: string
  dim: string
  focus: string
  error: string
  selectionBackground: string
  selectionForeground: string
}

const DARK_FALLBACK = { background: "#1c1c1c", foreground: "#eeeeee" }
const LIGHT_FALLBACK = { background: "#fafafa", foreground: "#262626" }

function mix(base: string, tint: string, amount: number): string {
  const channel = (offset: number) => {
    const from = Number.parseInt(base.slice(offset, offset + 2), 16)
    const to = Number.parseInt(tint.slice(offset, offset + 2), 16)
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function luminance(hex: string): number {
  const values = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = values.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

export async function editorTheme(renderer: CliRenderer): Promise<EditorTheme> {
  let detected:
    | {
        palette: Array<string | null>
        defaultForeground: string | null
        defaultBackground: string | null
        highlightBackground: string | null
        highlightForeground: string | null
      }
    | undefined
  try {
    detected = await renderer.getPalette({ timeout: 120, size: 16 })
  } catch {
    detected = undefined
  }

  const explicit = process.env.FX_THEME
  const fallback = explicit === "light" ? LIGHT_FALLBACK : explicit === "dark" ? DARK_FALLBACK : DARK_FALLBACK
  const background = detected?.defaultBackground ?? fallback.background
  const isLight = explicit === "light" || (explicit !== "dark" && luminance(background) > 0.5)
  const primary = detected?.defaultForeground ?? (isLight ? LIGHT_FALLBACK.foreground : DARK_FALLBACK.foreground)
  const palette = detected?.palette ?? []
  const focus = palette[4] ?? palette[12] ?? "#7dd3fc"
  const error = palette[1] ?? palette[9] ?? "#e5484d"
  const selectionBackground = detected?.highlightBackground ?? primary
  const selectionForeground = detected?.highlightForeground ?? background

  return {
    background,
    primary,
    dim: mix(background, primary, 0.5),
    focus,
    error,
    selectionBackground,
    selectionForeground,
  }
}
