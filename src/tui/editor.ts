import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import { loadJournal } from "../document/journal.js"
import { applyEdits, transformOffset, type TextEdit } from "../document/edits.js"
import { DocumentPersistence, loadDocument } from "../document/persistence.js"
import type { Transaction } from "../document/model.js"
import { SessionServer } from "../session/ipc.js"
import { DocumentLock } from "../session/paths.js"
import { DocumentService } from "../session/service.js"
import { editorTheme } from "./theme.js"

type EditorCallbacks = {
  quit: () => void
  undo: () => void
  redo: () => void
}

export const EXIT_CONFIRMATION_TIMEOUT_MS = 2_000
export const TRANSIENT_NOTICE_TIMEOUT_MS = 2_000

export class ExitConfirmation {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onArmedChange: (armed: boolean) => void,
    private readonly onConfirm: () => void,
    private readonly timeoutMs = EXIT_CONFIRMATION_TIMEOUT_MS,
  ) {}

  request(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
      this.onArmedChange(false)
      this.onConfirm()
      return
    }

    this.onArmedChange(true)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onArmedChange(false)
    }, this.timeoutMs)
  }

  cancel(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
    this.onArmedChange(false)
  }
}

export class TransientNotice {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onChange: (message: string | null) => void,
    private readonly timeoutMs = TRANSIENT_NOTICE_TIMEOUT_MS,
  ) {}

  show(message: string): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.onChange(message)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChange(null)
    }, this.timeoutMs)
  }

  cancel(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
    this.onChange(null)
  }
}

export class DocumentTextarea extends TextareaRenderable {
  callbacks: EditorCallbacks | null = null
  private killRing = ""
  private continuingKill = false

  constructor(ctx: RenderContext, options: ConstructorParameters<typeof TextareaRenderable>[1]) {
    super(ctx, options)
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    const kill = this.killCommand(key, name)
    if (kill) return kill()
    this.continuingKill = false

    if (key.ctrl && name === "c") {
      this.callbacks?.quit()
      return true
    }
    if ((key.ctrl && (name === "-" || name === "_")) || (key.super && name === "z" && !key.shift)) {
      this.callbacks?.undo()
      return true
    }
    if ((key.ctrl && name === ".") || (key.super && key.shift && name === "z")) {
      this.callbacks?.redo()
      return true
    }
    if (key.ctrl && name === "y") {
      if (this.killRing) this.insertText(this.killRing)
      return true
    }
    if (key.ctrl && name === "a" && !key.shift) return this.moveToLogicalLineBoundary("start")
    if (key.ctrl && name === "e" && !key.shift) return this.moveToLogicalLineBoundary("end")
    if (key.ctrl && name === "p") return this.moveCursorUp()
    if (key.ctrl && name === "n") return this.moveCursorDown()
    if (key.meta && (name === "<" || (name === "," && key.shift))) {
      this.clearSelection()
      return this.gotoBufferHome()
    }
    if (key.meta && (name === ">" || (name === "." && key.shift))) {
      this.clearSelection()
      return this.gotoBufferEnd()
    }
    if (name === "tab") {
      this.editIndent(key.shift)
      return true
    }
    if (key.ctrl && name === "t") {
      this.transposeCharacters()
      return true
    }
    if (key.meta && name === "t") {
      this.transposeWords()
      return true
    }
    return super.handleKeyPress(key)
  }

  private killCommand(key: KeyEvent, name: string): (() => boolean) | null {
    if (key.ctrl && name === "k") return () => this.killToLineEnd()
    if (key.ctrl && name === "u") return () => this.killToLineStart()
    if (key.ctrl && (name === "w" || name === "backspace")) return () => this.killUnixWordBackward()
    if (key.meta && name === "d") return () => this.killWordForward()
    if (key.meta && name === "backspace") return () => this.killWordBackward()
    return null
  }

  private selectedKillRange(): { start: number; end: number } | null {
    const selection = this.getSelection()
    return selection ? { start: selection.start, end: selection.end } : null
  }

  private killToLineEnd(): boolean {
    const text = this.plainText
    const cursor = this.cursorOffset
    const selection = this.selectedKillRange()
    if (selection) return this.killRange(selection.start, selection.end, "forward")
    const newline = text.indexOf("\n", cursor)
    const end = newline === -1 ? text.length : newline === cursor ? cursor + 1 : newline
    return this.killRange(cursor, end, "forward")
  }

  private killToLineStart(): boolean {
    const text = this.plainText
    const cursor = this.cursorOffset
    const selection = this.selectedKillRange()
    if (selection) return this.killRange(selection.start, selection.end, "backward")
    const start = text.lastIndexOf("\n", cursor - 1) + 1
    return this.killRange(start, cursor, "backward")
  }

  private killUnixWordBackward(): boolean {
    const cursor = this.cursorOffset
    const selection = this.selectedKillRange()
    if (selection) return this.killRange(selection.start, selection.end, "backward")
    const prefix = this.plainText.slice(0, cursor)
    const match = /(?:\S+\s*|\s+)$/u.exec(prefix)
    return this.killRange(match?.index ?? cursor, cursor, "backward")
  }

  private killWordBackward(): boolean {
    const cursor = this.cursorOffset
    const selection = this.selectedKillRange()
    if (selection) return this.killRange(selection.start, selection.end, "backward")
    const prefix = this.plainText.slice(0, cursor)
    const match = /(?:[\p{L}\p{N}_]+[^\p{L}\p{N}_]*|[^\p{L}\p{N}_]+)$/u.exec(prefix)
    return this.killRange(match?.index ?? cursor, cursor, "backward")
  }

  private killWordForward(): boolean {
    const text = this.plainText
    const cursor = this.cursorOffset
    const selection = this.selectedKillRange()
    if (selection) return this.killRange(selection.start, selection.end, "forward")
    const match = /^(?:[^\p{L}\p{N}_]*[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+)/u.exec(text.slice(cursor))
    return this.killRange(cursor, cursor + (match?.[0].length ?? 0), "forward")
  }

  private killRange(start: number, end: number, direction: "forward" | "backward"): boolean {
    if (start === end) return true
    const killed = this.plainText.slice(start, end)
    this.killRing = this.continuingKill
      ? direction === "backward"
        ? killed + this.killRing
        : this.killRing + killed
      : killed
    this.continuingKill = true
    this.setSelection(start, end)
    this.deleteSelection()
    return true
  }

  private moveToLogicalLineBoundary(boundary: "start" | "end"): boolean {
    const text = this.plainText
    const cursor = this.cursorOffset
    const target =
      boundary === "start"
        ? text.lastIndexOf("\n", cursor - 1) + 1
        : (text.indexOf("\n", cursor) === -1 ? text.length : text.indexOf("\n", cursor))
    this.clearSelection()
    this.cursorOffset = target
    return true
  }

  private editIndent(outdent: boolean): void {
    const text = this.plainText
    const selection = this.getSelection()
    if (!selection && !outdent) {
      this.insertText("  ")
      return
    }
    const cursor = this.cursorOffset
    const rangeStart = selection?.start ?? cursor
    const rangeEnd = selection?.end ?? cursor
    const firstLineStart = text.lastIndexOf("\n", Math.max(0, rangeStart - 1)) + 1
    const edits: TextEdit[] = []
    let lineStart = firstLineStart
    while (lineStart <= rangeEnd) {
      if (lineStart === rangeEnd && lineStart !== firstLineStart) break
      if (outdent) {
        const remove = text[lineStart] === "\t" ? 1 : text.slice(lineStart, lineStart + 2).match(/^ +/)?.[0].length ?? 0
        if (remove > 0) edits.push({ start: lineStart, end: lineStart + remove, text: "" })
      } else edits.push({ start: lineStart, end: lineStart, text: "  " })
      const newline = text.indexOf("\n", lineStart)
      if (newline === -1) break
      lineStart = newline + 1
    }
    if (edits.length === 0) return
    this.replaceText(applyEdits(text, edits))
    this.cursorOffset = transformOffset(cursor, edits)
    if (selection) {
      this.setSelection(
        transformOffset(selection.start, edits, "before"),
        transformOffset(selection.end, edits, "after"),
      )
    }
  }

  private transposeCharacters(): void {
    const cursor = this.cursorOffset
    if (cursor < 2) return
    const prefix = this.plainText.slice(0, cursor)
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(prefix)]
    if (segments.length < 2) return
    const left = segments.at(-2)!
    const right = segments.at(-1)!
    const start = left.index
    this.setSelection(start, cursor)
    this.deleteSelection()
    this.insertText(right.segment + left.segment)
  }

  private transposeWords(): void {
    const cursor = this.cursorOffset
    const prefix = this.plainText.slice(0, cursor)
    const match = /([\p{L}\p{N}_]+)([^\p{L}\p{N}_]+)([\p{L}\p{N}_]+)$/u.exec(prefix)
    if (!match || match.index === undefined) return
    this.setSelection(match.index, cursor)
    this.deleteSelection()
    this.insertText(match[3]! + match[2]! + match[1]!)
  }
}

export function applyTransactionToEditorState(
  editor: DocumentTextarea,
  text: string,
  transaction: Transaction,
): void {
  const cursor = transformOffset(editor.cursorOffset, transaction.edits)
  const selection = editor.getSelection()
  const viewport = editor.editorView.getViewport()
  editor.setText(text)
  editor.cursorOffset = Math.min(cursor, text.length)
  if (selection) {
    editor.setSelection(
      transformOffset(selection.start, transaction.edits, "before"),
      transformOffset(selection.end, transaction.edits, "after"),
    )
  }
  editor.editorView.setViewport(
    viewport.offsetX,
    viewport.offsetY,
    viewport.width,
    viewport.height,
    false,
  )
}

export async function runEditor(inputPath: string): Promise<void> {
  const loaded = loadDocument(inputPath, true)
  const lock = new DocumentLock(loaded.path)
  lock.acquire()
  const model = loadJournal(lock.paths.journal, loaded.text)
  const service = new DocumentService({
    model,
    persistence: new DocumentPersistence(loaded),
    journalPath: lock.paths.journal,
  })
  const session = new SessionServer(service, lock)
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let exitConfirmation: ExitConfirmation | null = null
  let transientNotice: TransientNotice | null = null

  try {
    await session.start()
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
      useMouse: true,
      screenMode: "alternate-screen",
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    })
    const theme = await editorTheme(renderer)
    renderer.setBackgroundColor(theme.background)
    const root = new BoxRenderable(renderer, {
      id: "root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.background,
    })
    let syncing = false
    let done: () => void = () => {}
    let closing = false
    let syncEditorText: () => void = () => {}
    let exitArmed = false
    let transientMessage: string | null = null
    let saveErrorMessage: string | null = null
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
      noticeText.fg = exitArmed ? theme.primary : theme.error
      noticeBox.visible = message !== null
    }
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const finish = () => {
      if (closing) return
      exitConfirmation?.cancel()
      syncEditorText()
      try {
        service.flush()
      } catch {
        return
      }
      closing = true
      done()
    }
    const undoStack: string[] = []
    const redoStack: string[] = []

    const editor = new DocumentTextarea(renderer, {
      id: "document",
      width: "100%",
      height: "100%",
      initialValue: service.model.text,
      wrapMode: isMarkdown(loaded.path) ? "word" : "none",
      scrollMargin: 3,
      textColor: theme.primary,
      focusedTextColor: theme.primary,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
      selectionBg: theme.selectionBackground,
      selectionFg: theme.selectionForeground,
      cursorColor: theme.focus,
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
          const region = activeLine(service.model.text, editor.cursorOffset)
          service.setActiveRegion(region.start, region.end)
        })
      },
    })
    syncEditorText = () => {
      if (syncing || editor.plainText === service.model.text) return
      const result = service.applyHumanText(editor.plainText, activeLine(editor.plainText, editor.cursorOffset))
      if (result.transaction) {
        undoStack.push(result.transaction.id)
        redoStack.length = 0
      }
    }

    const applyTransactionToEditor = (transaction: Transaction): void => {
      syncing = true
      try {
        applyTransactionToEditorState(editor, service.model.text, transaction)
      } finally {
        syncing = false
      }
    }

    const undo = (): void => {
      const id = undoStack.pop()
      if (!id) return
      try {
        const undone = service.undoTransaction(id)
        if (undone.transaction) {
          applyTransactionToEditor(undone.transaction)
          redoStack.push(undone.transaction.id)
        }
      } catch (error) {
        transientNotice?.show(error instanceof Error ? error.message : String(error))
      }
    }

    const redo = (): void => {
      const id = redoStack.pop()
      if (!id) return
      try {
        const redone = service.undoTransaction(id)
        if (redone.transaction) {
          applyTransactionToEditor(redone.transaction)
          undoStack.push(redone.transaction.id)
        }
      } catch (error) {
        transientNotice?.show(error instanceof Error ? error.message : String(error))
      }
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

    service.subscribe((transaction) => {
      if (closing) return
      if (transaction.actor === "human") return
      applyTransactionToEditor(transaction)
    })
    service.subscribeSaveError((error) => {
      if (closing) return
      saveErrorMessage = error ? `save failed — ${error.message}` : null
      refreshNotice()
    })

    root.add(editor)
    root.add(noticeBox)
    renderer.root.add(root)
    editor.focus()
    renderer.start()
    await finished
    renderer.destroy()
    renderer = null
  } finally {
    exitConfirmation?.cancel()
    transientNotice?.cancel()
    if (renderer) renderer.destroy()
    try {
      service.close()
    } finally {
      await session.close()
      lock.release()
    }
  }
}

function activeLine(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
  const newline = text.indexOf("\n", cursor)
  return { start, end: newline === -1 ? text.length : newline + 1 }
}

function isMarkdown(path: string): boolean {
  return /\.(?:md|mdx|markdown)$/i.test(path)
}
