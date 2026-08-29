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
import type { Transaction } from "../document/model.js"
import type { SurfaceMode, ViewState } from "../storage/database.js"
import type { SurfaceService } from "../surface/service.js"
import {
  DocumentTextarea,
  ExitConfirmation,
  TransientNotice,
  applyTransactionToEditorState,
} from "./editor.js"
import { editorTheme, type EditorTheme } from "./theme.js"

type ConfigurationField = "model" | "effort"

type ConfigurationPanelOptions = {
  theme: EditorTheme
  onCycle: (field: ConfigurationField, delta: -1 | 1) => void
  onQuit: () => void
}

export function configurationPanelHeight(width: number): number {
  return width < 55 ? 2 : 1
}

export function configurationPanelText(input: {
  width: number
  model: string | null
  effort: string | null
  selected: ConfigurationField
  focused: boolean
}): string {
  const values = fittedConfigurationValues(input.width, input.model, input.effort)
  const field = (name: ConfigurationField, value: string): string =>
    `${input.focused && input.selected === name ? "▎" : " "} ${name}  ${value}`
  const model = field("model", values.model)
  const effort = field("effort", values.effort)
  return configurationPanelHeight(input.width) === 1 ? `${model}  ·  ${effort}` : `${model}\n${effort}`
}

export class ConfigurationPanel extends BoxRenderable {
  private readonly text: TextRenderable
  private selected: ConfigurationField = "model"
  private theme: EditorTheme
  private model: string | null = null
  private effort: string | null = null
  private layoutWidth: number

  constructor(ctx: RenderContext, private readonly options: ConfigurationPanelOptions) {
    const height = configurationPanelHeight(ctx.width)
    super(ctx, {
      id: "configuration",
      width: "100%",
      height,
      flexShrink: 0,
      focusable: true,
      backgroundColor: options.theme.surface,
      shouldFill: true,
    })
    this.theme = options.theme
    this.layoutWidth = ctx.width
    this.text = new TextRenderable(ctx, {
      id: "configuration-values",
      width: "100%",
      height,
      content: "",
      fg: options.theme.primary,
      bg: options.theme.surface,
      selectable: false,
      truncate: true,
    })
    this.add(this.text)
    this.refresh()
  }

  get selectedField(): ConfigurationField {
    return this.selected
  }

  setConfiguration(model: string | null, effort: string | null): void {
    this.model = model
    this.effort = effort
    this.refresh()
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme
    this.backgroundColor = theme.surface
    this.text.bg = theme.surface
    this.refresh()
  }

  resizeForWidth(width: number): void {
    this.layoutWidth = Math.max(1, Math.trunc(width))
    const height = configurationPanelHeight(this.layoutWidth)
    this.height = height
    this.text.height = height
    this.refresh()
  }

  override focus(): void {
    super.focus()
    this.refresh()
  }

  override blur(): void {
    super.blur()
    this.refresh()
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (key.ctrl && name === "c") {
      this.options.onQuit()
      return true
    }
    if (name === "tab") {
      this.selected = this.selected === "model" ? "effort" : "model"
      this.refresh()
      return true
    }
    if (name === "left" || name === "up") {
      this.options.onCycle(this.selected, -1)
      return true
    }
    if (name === "right" || name === "down") {
      this.options.onCycle(this.selected, 1)
      return true
    }
    return false
  }

  private refresh(): void {
    if (this.text.isDestroyed) return
    const values = fittedConfigurationValues(this.layoutWidth, this.model, this.effort)
    const chunks = []
    const addField = (field: ConfigurationField, value: string): void => {
      const selected = this.focused && this.selected === field
      chunks.push(fg(selected ? this.theme.focus : this.theme.dim)(selected ? "▎" : " "))
      chunks.push(fg(this.theme.secondary)(` ${field}  `))
      chunks.push(selected ? bold(fg(this.theme.primary)(value)) : fg(this.theme.primary)(value))
    }

    addField("model", values.model)
    if (configurationPanelHeight(this.layoutWidth) === 1) chunks.push(fg(this.theme.dim)("  ·  "))
    else chunks.push(fg(this.theme.dim)("\n"))
    addField("effort", values.effort)
    this.text.content = new StyledText(chunks)
  }
}

export async function runSurface(service: SurfaceService): Promise<void> {
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let exitConfirmation: ExitConfirmation | null = null
  let transientNotice: TransientNotice | null = null
  let unsubscribe: (() => void) | null = null
  let themeController: Awaited<ReturnType<typeof editorTheme>> | null = null

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
      useMouse: true,
      screenMode: "alternate-screen",
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    })
    themeController = await editorTheme(renderer)
    let theme = themeController.current
    renderer.setBackgroundColor(theme.background)

    const root = new BoxRenderable(renderer, {
      id: "root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
    })
    const stage = new BoxRenderable(renderer, {
      id: "stage",
      width: "100%",
      height: "100%",
      flexGrow: 1,
      flexShrink: 1,
      backgroundColor: theme.background,
      alignItems: "center",
      justifyContent: "center",
    })

    let syncing = false
    let closing = false
    let done: () => void = () => {}
    let syncEditorText: () => void = () => {}
    let captureView: () => void = () => {}
    let exitArmed = false
    let transientMessage: string | null = null
    let saveErrorMessage: string | null = null
    let terminalCursorColorRestored = false

    const noticeBox = new BoxRenderable(renderer, {
      id: "notice",
      position: "absolute",
      left: 0,
      bottom: 0,
      width: "100%",
      height: 1,
      zIndex: 100,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.background,
      visible: false,
    })
    const noticeText = new TextRenderable(renderer, {
      content: "",
      width: "auto",
      height: 1,
      fg: theme.primary,
      bg: theme.background,
      selectable: false,
      truncate: true,
    })
    noticeBox.add(noticeText)

    const refreshNotice = (): void => {
      const message = exitArmed ? "press ctrl+c again to exit" : transientMessage ?? saveErrorMessage
      noticeText.content = message ?? ""
      noticeText.fg = exitArmed ? theme.primary : theme.accent
      noticeBox.visible = message !== null
    }
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const finish = (): void => {
      if (closing) return
      exitConfirmation?.cancel()
      syncEditorText()
      captureView()
      try {
        service.flush()
      } catch {
        return
      }
      closing = true
      done()
    }

    const history = new Map<string, { undo: string[]; redo: string[] }>()
    const focusedHistory = (): { undo: string[]; redo: string[] } | null => {
      const id = service.getSurfaceState(false).focused_document?.document_id
      if (!id) return null
      let stacks = history.get(id)
      if (!stacks) {
        stacks = { undo: [], redo: [] }
        history.set(id, stacks)
      }
      return stacks
    }

    const editor = new DocumentTextarea(renderer, {
      id: "document",
      width: "100%",
      height: "100%",
      initialValue: service.getSurfaceState(false).focused_document?.content ?? "",
      wrapMode: "word",
      scrollMargin: 3,
      textColor: theme.primary,
      focusedTextColor: theme.primary,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
      selectionBg: theme.selectionBackground,
      selectionFg: theme.selectionForeground,
      tabIndicator: "→",
      tabIndicatorColor: theme.dim,
      onContentChange: () => {
        if (syncing || closing) return
        queueMicrotask(() => {
          if (!syncing && !closing) syncEditorText()
        })
      },
      onCursorChange: () => {
        queueMicrotask(() => {
          if (closing) return
          const region = activeLine(editor.plainText, editor.cursorOffset)
          service.setActiveRegion(region.start, region.end)
          captureView()
        })
      },
    })

    captureView = (): void => {
      if (closing || syncing || !editor.visible) return
      const viewport = editor.editorView.getViewport()
      const selection = editor.getSelection()
      service.setFocusedView({
        cursor: editor.cursorOffset,
        selectionStart: selection?.start ?? null,
        selectionEnd: selection?.end ?? null,
        viewportX: viewport.offsetX,
        viewportY: viewport.offsetY,
      })
    }

    syncEditorText = (): void => {
      const state = service.getSurfaceState(false)
      if (syncing || !state.focused_document || editor.plainText === state.focused_document.content) return
      const result = service.applyHumanText(
        editor.plainText,
        activeLine(editor.plainText, editor.cursorOffset),
      )
      if (result.transaction) {
        const stacks = focusedHistory()
        stacks?.undo.push(result.transaction.id)
        if (stacks) stacks.redo.length = 0
      }
      captureView()
    }

    const applyTransactionToEditor = (text: string, transaction: Transaction): void => {
      syncing = true
      try {
        applyTransactionToEditorState(editor, text, transaction)
      } finally {
        syncing = false
      }
      captureView()
    }

    const undo = (): void => {
      const stacks = focusedHistory()
      const id = stacks?.undo.pop()
      if (!id) return
      try {
        const undone = service.undoHuman(id)
        if (undone.transaction) {
          applyTransactionToEditor(undone.text, undone.transaction)
          stacks?.redo.push(undone.transaction.id)
        }
      } catch (error) {
        stacks?.undo.push(id)
        transientNotice?.show(error instanceof Error ? error.message : String(error))
      }
    }

    const redo = (): void => {
      const stacks = focusedHistory()
      const id = stacks?.redo.pop()
      if (!id) return
      try {
        const redone = service.undoHuman(id)
        if (redone.transaction) {
          applyTransactionToEditor(redone.text, redone.transaction)
          stacks?.undo.push(redone.transaction.id)
        }
      } catch (error) {
        stacks?.redo.push(id)
        transientNotice?.show(error instanceof Error ? error.message : String(error))
      }
    }

    let configuration: ConfigurationPanel | null = null
    configuration = new ConfigurationPanel(renderer, {
      theme,
      onCycle: (field, delta) => {
        try {
          service.cycleConfiguration(field, delta)
        } catch {
          transientNotice?.show("save failed")
        }
      },
      onQuit: () => exitConfirmation?.request(),
    })
    const panel = configuration

    const standby = new TextRenderable(renderer, {
      id: "standby",
      width: "auto",
      height: 1,
      content: "standby",
      fg: theme.dim,
      bg: theme.background,
      selectable: false,
    })

    const restoreView = (view: ViewState | null): void => {
      if (!view) return
      editor.cursorOffset = Math.min(view.cursor, editor.plainText.length)
      if (view.selectionStart !== null && view.selectionEnd !== null) {
        editor.setSelection(view.selectionStart, view.selectionEnd)
      } else editor.clearSelection()
      const viewport = editor.editorView.getViewport()
      editor.editorView.setViewport(
        view.viewportX,
        view.viewportY,
        Math.max(1, viewport.width),
        Math.max(1, viewport.height),
        false,
      )
    }

    const syncFocusedDocument = (): void => {
      const document = service.getSurfaceState(false).focused_document
      syncing = true
      try {
        editor.setText(document?.content ?? "")
        restoreView(service.getFocusedView())
      } finally {
        syncing = false
      }
      if (document) {
        const region = activeLine(document.content, editor.cursorOffset)
        service.setActiveRegion(region.start, region.end)
      }
    }

    const applyMode = (mode: SurfaceMode, preserveFocus = true): void => {
      const state = service.getSurfaceState(false)
      const showDocument = mode === "document" || mode === "document_configuration"
      const showConfiguration = mode === "configuration" || mode === "document_configuration"
      editor.visible = showDocument && state.focused_document !== null
      panel.visible = showConfiguration && state.focused_document !== null
      standby.visible = mode === "standby"
      panel.setConfiguration(
        state.focused_document?.model ?? null,
        state.focused_document?.effort ?? null,
      )

      const focused = renderer?.currentFocusedRenderable
      if (preserveFocus && focused?.visible) return
      if (mode === "configuration" && panel.visible) panel.focus()
      else if (editor.visible) editor.focus()
      else {
        editor.blur()
        panel.blur()
      }
    }

    const applyTheme = (next: EditorTheme): void => {
      theme = next
      renderer?.setBackgroundColor(next.background)
      root.backgroundColor = next.background
      stage.backgroundColor = next.background
      editor.textColor = next.primary
      editor.focusedTextColor = next.primary
      editor.backgroundColor = next.background
      editor.focusedBackgroundColor = next.background
      editor.selectionBg = next.selectionBackground
      editor.selectionFg = next.selectionForeground
      editor.tabIndicatorColor = next.dim
      standby.fg = next.dim
      standby.bg = next.background
      panel.setTheme(next)
      noticeBox.backgroundColor = next.background
      noticeText.bg = next.background
      refreshNotice()
    }

    transientNotice = new TransientNotice((message) => {
      if (closing) return
      transientMessage = message
      refreshNotice()
    })
    exitConfirmation = new ExitConfirmation(
      (armed) => {
        exitArmed = armed
        refreshNotice()
      },
      finish,
    )
    editor.callbacks = {
      quit: () => exitConfirmation?.request(),
      undo,
      redo,
    }

    unsubscribe = service.subscribe((event) => {
      if (closing) return
      switch (event.kind) {
        case "focus_changed":
          syncFocusedDocument()
          applyMode(service.getSurfaceState(false).mode, false)
          break
        case "mode_changed":
          applyMode(service.getSurfaceState(false).mode)
          break
        case "configuration_changed": {
          const document = service.getSurfaceState(false).focused_document
          if (document?.document_id === event.documentId) {
            panel.setConfiguration(document.model, document.effort)
          }
          break
        }
        case "document_changed": {
          const document = service.getSurfaceState(false).focused_document
          if (event.transaction.actor === "assistant" && document?.document_id === event.documentId) {
            applyTransactionToEditor(document.content, event.transaction)
          }
          break
        }
        case "save_error":
          saveErrorMessage = event.error ? "save failed" : null
          refreshNotice()
          break
        case "documents_changed":
          break
      }
    })

    stage.add(editor)
    stage.add(standby)
    root.add(stage)
    root.add(panel)
    root.add(noticeBox)
    renderer.root.add(root)
    syncFocusedDocument()
    panel.resizeForWidth(renderer.width)
    applyMode(service.getSurfaceState(false).mode, false)

    const keyHandler = (key: KeyEvent): void => {
      const name = key.name.toLowerCase()
      if (key.ctrl && name === "c") {
        key.preventDefault()
        key.stopPropagation()
        exitConfirmation?.request()
      }
    }
    const frameHandler = (): void => {
      captureView()
      if (editor.focused && !terminalCursorColorRestored) {
        themeController?.restoreTerminalCursorColor()
        terminalCursorColorRestored = true
      }
    }
    const resizeHandler = (): void => panel.resizeForWidth(renderer?.width ?? 80)
    renderer.keyInput.on("keypress", keyHandler)
    renderer.on("frame", frameHandler)
    renderer.on("resize", resizeHandler)
    themeController.start(applyTheme)
    renderer.start()
    await finished

    renderer.keyInput.off("keypress", keyHandler)
    renderer.off("frame", frameHandler)
    renderer.off("resize", resizeHandler)
    themeController.dispose()
    themeController = null
    unsubscribe()
    unsubscribe = null
    renderer.destroy()
    renderer = null
  } finally {
    unsubscribe?.()
    exitConfirmation?.cancel()
    transientNotice?.cancel()
    themeController?.dispose()
    if (renderer) renderer.destroy()
  }
}

function activeLine(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
  const newline = text.indexOf("\n", cursor)
  return { start, end: newline === -1 ? text.length : newline + 1 }
}

function fittedConfigurationValues(
  width: number,
  model: string | null,
  effort: string | null,
): { model: string; effort: string } {
  const modelValue = model ?? "unavailable"
  const effortValue = effort ?? "unavailable"
  if (configurationPanelHeight(width) === 2) {
    return {
      model: fitValue(modelValue, Math.max(1, width - 9)),
      effort: fitValue(effortValue, Math.max(1, width - 10)),
    }
  }

  const available = Math.max(2, width - 24)
  const effortWidth = Math.min(Math.max(4, effortValue.length), Math.min(12, available - 1))
  return {
    model: fitValue(modelValue, Math.max(1, available - effortWidth)),
    effort: fitValue(effortValue, Math.max(1, effortWidth)),
  }
}

function fitValue(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return "…"
  return `${value.slice(0, width - 1)}…`
}
