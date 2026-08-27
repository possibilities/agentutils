import {
  BoxRenderable,
  InputRenderable,
  StyledText,
  TextRenderable,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type { EditorTheme } from "./theme.js"

export type Command = { label: string; run: () => void }

type OverlayCallbacks = {
  close: () => void
  submit: () => void
  move: (delta: number) => void
}

class OverlayInput extends InputRenderable {
  callbacks: OverlayCallbacks | null = null

  constructor(ctx: RenderContext, options: ConstructorParameters<typeof InputRenderable>[1]) {
    super(ctx, options)
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (name === "escape" || (key.meta && name === "x")) {
      this.callbacks?.close()
      return true
    }
    if (name === "up") {
      this.callbacks?.move(-1)
      return true
    }
    if (name === "down") {
      this.callbacks?.move(1)
      return true
    }
    if (name === "return" || name === "kpenter" || name === "linefeed") {
      this.callbacks?.submit()
      return true
    }
    return super.handleKeyPress(key)
  }
}

export class CommandOverlay {
  readonly box: BoxRenderable
  private readonly renderer: CliRenderer
  private readonly input: OverlayInput
  private readonly rows: TextRenderable
  private readonly theme: EditorTheme
  private readonly allCommands: () => Command[]
  private readonly onClose: () => void
  private filtered: Command[] = []
  private selected = 0

  constructor(
    renderer: CliRenderer,
    theme: EditorTheme,
    allCommands: () => Command[],
    onClose: () => void,
  ) {
    this.renderer = renderer
    this.theme = theme
    this.allCommands = allCommands
    this.onClose = onClose
    const width = Math.max(20, Math.min(58, renderer.terminalWidth - 4))
    const height = Math.max(5, Math.min(14, renderer.terminalHeight - 4))
    this.box = new BoxRenderable(renderer, {
      id: "command-overlay",
      position: "absolute",
      left: Math.max(1, Math.floor((renderer.terminalWidth - width) / 2)),
      top: Math.max(1, Math.floor((renderer.terminalHeight - height) / 3)),
      width,
      height,
      zIndex: 100,
      flexDirection: "column",
      paddingX: 1,
      paddingY: 1,
      border: true,
      borderStyle: "single",
      borderColor: theme.focus,
      backgroundColor: theme.background,
    })
    this.input = new OverlayInput(renderer, {
      id: "command-filter",
      width: "100%",
      value: "",
      placeholder: "command",
      textColor: theme.primary,
      focusedTextColor: theme.primary,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
      placeholderColor: theme.dim,
      cursorColor: theme.focus,
      onContentChange: () => queueMicrotask(() => this.repaint()),
    })
    this.rows = new TextRenderable(renderer, {
      id: "command-rows",
      width: "100%",
      flexGrow: 1,
      content: "",
      selectable: false,
    })
    this.input.callbacks = {
      close: () => this.close(),
      submit: () => this.submit(),
      move: (delta) => this.move(delta),
    }
    this.box.add(this.input)
    this.box.add(this.rows)
    this.repaint()
  }

  focus(): void {
    this.input.focus()
  }

  close(): void {
    this.onClose()
  }

  private repaint(): void {
    const query = this.input.value.toLocaleLowerCase()
    this.filtered = this.allCommands().filter((command) => command.label.toLocaleLowerCase().includes(query))
    this.selected = Math.max(0, Math.min(this.selected, this.filtered.length - 1))
    const availableRows = Math.max(1, this.box.height - 4)
    const start = Math.max(0, Math.min(this.selected - Math.floor(availableRows / 2), this.filtered.length - availableRows))
    const chunks: TextChunk[] = []
    for (const [visibleIndex, command] of this.filtered.slice(start, start + availableRows).entries()) {
      if (visibleIndex > 0) chunks.push(fg(this.theme.background)("\n"))
      const actualIndex = start + visibleIndex
      if (actualIndex === this.selected) {
        chunks.push(fg(this.theme.focus)("> "))
        chunks.push(bold(fg(this.theme.primary)(command.label)))
      }
      else chunks.push(fg(this.theme.secondary)(`  ${command.label}`))
    }
    if (chunks.length === 0) chunks.push(fg(this.theme.dim)("  no matching command"))
    this.rows.content = new StyledText(chunks)
    this.renderer.requestRender()
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return
    this.selected = (this.selected + delta + this.filtered.length) % this.filtered.length
    this.repaint()
  }

  private submit(): void {
    this.repaint()
    const command = this.filtered[this.selected]
    if (!command) return
    this.onClose()
    command.run()
  }
}

type PromptCallbacks = { close: () => void; submit: (value: string) => void }

class PromptInput extends InputRenderable {
  callbacks: PromptCallbacks | null = null

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (name === "escape") {
      this.callbacks?.close()
      return true
    }
    if (name === "return" || name === "kpenter" || name === "linefeed") {
      this.callbacks?.submit(this.value)
      return true
    }
    return super.handleKeyPress(key)
  }
}

export class PromptOverlay {
  readonly box: BoxRenderable
  private readonly input: PromptInput

  constructor(
    renderer: CliRenderer,
    theme: EditorTheme,
    placeholder: string,
    onSubmit: (value: string) => void,
    onClose: () => void,
  ) {
    const width = Math.max(20, Math.min(64, renderer.terminalWidth - 4))
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: Math.max(1, Math.floor((renderer.terminalWidth - width) / 2)),
      top: Math.max(1, Math.floor(renderer.terminalHeight / 3)),
      width,
      height: 3,
      zIndex: 100,
      paddingX: 1,
      border: true,
      borderStyle: "single",
      borderColor: theme.focus,
      backgroundColor: theme.background,
    })
    this.input = new PromptInput(renderer, {
      width: "100%",
      value: "",
      placeholder,
      textColor: theme.primary,
      focusedTextColor: theme.primary,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
      placeholderColor: theme.dim,
      cursorColor: theme.focus,
    })
    this.input.callbacks = { submit: onSubmit, close: onClose }
    this.box.add(this.input)
  }

  focus(): void {
    this.input.focus()
  }
}

export function errorOverlay(renderer: CliRenderer, theme: EditorTheme, message: string): BoxRenderable {
  const width = Math.max(24, Math.min(70, renderer.terminalWidth - 4))
  const height = Math.max(4, Math.min(6, renderer.terminalHeight - 2))
  const box = new BoxRenderable(renderer, {
    position: "absolute",
    left: Math.max(1, Math.floor((renderer.terminalWidth - width) / 2)),
    top: Math.max(1, Math.floor(renderer.terminalHeight / 3)),
    width,
    height,
    zIndex: 110,
    paddingX: 1,
    border: true,
    borderStyle: "single",
    borderColor: theme.error,
    backgroundColor: theme.background,
  })
  box.add(
    new TextRenderable(renderer, {
      content: message,
      fg: theme.primary,
      width: "100%",
      height: Math.max(1, height - 2),
      wrapMode: "word",
    }),
  )
  return box
}
