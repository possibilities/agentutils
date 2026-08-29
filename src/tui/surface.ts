import {
  BoxRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
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
import { ConfigurationPanel } from "./configuration.js"
import { editorTheme, type EditorTheme } from "./theme.js"

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

    let panel: ConfigurationPanel
    panel = new ConfigurationPanel(renderer, {
      theme,
      models: service.catalog.models,
      onSelect: (configuration) => {
        try {
          service.setConfiguration(configuration)
          return true
        } catch {
          transientNotice?.show("save failed")
          return false
        }
      },
      onRequestDocumentFocus: () => {
        if (editor.visible) editor.focus()
        else panel.closeMenu()
      },
      onQuit: () => exitConfirmation?.request(),
    })

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

      const focused = renderer?.currentFocusedRenderable ?? null
      const panelFocused = panel.ownsFocus(focused)
      if (!panel.visible && panelFocused) panel.releaseFocus()
      if (
        preserveFocus &&
        ((focused === editor && editor.visible) || (panelFocused && panel.visible))
      ) {
        return
      }
      if (mode === "configuration" && panel.visible) panel.focusModel()
      else if (editor.visible) editor.focus()
      else {
        editor.blur()
        panel.releaseFocus()
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
    panel.resizeForSize(renderer.width, renderer.height)
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
    const resizeHandler = (): void =>
      panel.resizeForSize(renderer?.width ?? 80, renderer?.height ?? 24)
    const focusHandler = (focused: unknown): void => {
      if (focused === editor) panel.closeMenu()
    }
    renderer.keyInput.on("keypress", keyHandler)
    renderer.on("frame", frameHandler)
    renderer.on("resize", resizeHandler)
    renderer.on("focused_renderable", focusHandler)
    themeController.start(applyTheme)
    renderer.start()
    await finished

    renderer.keyInput.off("keypress", keyHandler)
    renderer.off("frame", frameHandler)
    renderer.off("resize", resizeHandler)
    renderer.off("focused_renderable", focusHandler)
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
