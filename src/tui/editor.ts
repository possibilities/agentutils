import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  fg,
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
import { CommandOverlay, PromptOverlay, errorOverlay, type Command } from "./overlay.js"
import { editorTheme, type EditorTheme } from "./theme.js"

type EditorCallbacks = {
  quit: () => void
  commands: () => void
  save: () => void
  undo: () => void
  redo: () => void
  closeOverlay: () => boolean
}

class DocumentTextarea extends TextareaRenderable {
  callbacks: EditorCallbacks | null = null
  private killRing = ""

  constructor(ctx: RenderContext, options: ConstructorParameters<typeof TextareaRenderable>[1]) {
    super(ctx, options)
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (name === "escape" && this.callbacks?.closeOverlay()) return true
    if (key.ctrl && name === "c") {
      this.callbacks?.quit()
      return true
    }
    if (key.ctrl && name === "s") {
      this.callbacks?.save()
      return true
    }
    if (key.meta && name === "x") {
      this.callbacks?.commands()
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
    if (key.ctrl && (name === "k" || name === "u" || name === "w")) this.captureKill(name)
    return super.handleKeyPress(key)
  }

  private captureKill(name: string): void {
    const text = this.plainText
    const cursor = this.cursorOffset
    let start = cursor
    let end = cursor
    if (name === "k") {
      const newline = text.indexOf("\n", cursor)
      end = newline === -1 ? text.length : newline
    } else if (name === "u") {
      start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
    } else {
      const prefix = text.slice(0, cursor)
      const match = /(?:\s+|[^\p{L}\p{N}_]+|[\p{L}\p{N}_]+)$/u.exec(prefix)
      start = match ? cursor - match[0].length : cursor
    }
    this.killRing = text.slice(start, end)
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

export async function runEditor(inputPath: string): Promise<void> {
  const loaded = loadDocument(inputPath, true)
  const lock = new DocumentLock(loaded.path)
  lock.acquire()
  const model = loadJournal(lock.paths.journal, loaded.text)
  const service = new DocumentService({
    model,
    persistence: new DocumentPersistence(loaded),
    journalPath: lock.paths.journal,
    sessionActive: true,
  })
  const session = new SessionServer(service, lock)
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null

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
    let overlay: BoxRenderable | null = null
    let preview: ScrollBoxRenderable | null = null
    let errorBox: BoxRenderable | null = null
    let done: () => void = () => {}
    let closing = false
    let syncEditorText: () => void = () => {}
    let reportSaveError: (message: string) => void = () => {}
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const finish = () => {
      if (closing) return
      syncEditorText()
      try {
        service.flush()
      } catch (error) {
        reportSaveError(error instanceof Error ? error.message : String(error))
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

    const closeOverlay = (): boolean => {
      if (preview) {
        root.remove(preview)
        preview.destroyRecursively()
        preview = null
        root.add(editor)
        editor.focus()
        return true
      }
      if (!overlay) return false
      root.remove(overlay)
      overlay.destroyRecursively()
      overlay = null
      editor.focus()
      return true
    }

    const showError = (message: string): void => {
      if (errorBox) {
        root.remove(errorBox)
        errorBox.destroyRecursively()
      }
      errorBox = errorOverlay(renderer!, theme, message)
      root.add(errorBox)
    }
    reportSaveError = (message) => showError(`save failed — ${message} — ctrl+s retries`)

    const clearError = (): void => {
      if (!errorBox) return
      root.remove(errorBox)
      errorBox.destroyRecursively()
      errorBox = null
    }

    const flush = (): void => {
      try {
        service.flush()
        clearError()
      } catch (error) {
        reportSaveError(error instanceof Error ? error.message : String(error))
      }
    }

    const applyTransactionToEditor = (transaction: Transaction): void => {
      const cursor = transformOffset(editor.cursorOffset, transaction.edits)
      const selection = editor.getSelection()
      const viewport = editor.editorView.getViewport()
      syncing = true
      editor.setText(service.model.text)
      editor.cursorOffset = Math.min(cursor, service.model.text.length)
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
      syncing = false
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
        showError(error instanceof Error ? error.message : String(error))
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
        showError(error instanceof Error ? error.message : String(error))
      }
    }

    const prompt = (placeholder: string, submit: (value: string) => void): void => {
      closeOverlay()
      const promptOverlay = new PromptOverlay(
        renderer!,
        theme,
        placeholder,
        (value) => {
          closeOverlay()
          submit(value)
        },
        () => closeOverlay(),
      )
      overlay = promptOverlay.box
      root.add(overlay)
      promptOverlay.focus()
    }

    const find = (): void => {
      prompt("find", (query) => {
        if (!query) return
        const text = editor.plainText
        let index = text.indexOf(query, editor.cursorOffset)
        if (index === -1) index = text.indexOf(query)
        if (index !== -1) {
          editor.setSelection(index, index + query.length)
          editor.cursorOffset = index + query.length
        }
      })
    }

    const replace = (): void => {
      prompt("find", (query) => {
        if (!query) return
        prompt("replace with", (replacement) => {
          const text = editor.plainText
          let index = text.indexOf(query, editor.cursorOffset)
          if (index === -1) index = text.indexOf(query)
          if (index === -1) return
          editor.setSelection(index, index + query.length)
          editor.deleteSelection()
          editor.insertText(replacement)
        })
      })
    }

    const showPreview = (): void => {
      closeOverlay()
      root.remove(editor)
      const syntaxStyle = markdownStyle(theme)
      preview = new ScrollBoxRenderable(renderer!, {
        id: "preview",
        width: "100%",
        height: "100%",
        scrollY: true,
        scrollX: false,
        backgroundColor: theme.background,
        verticalScrollbarOptions: { visible: false },
      })
      preview.add(
        new MarkdownRenderable(renderer!, {
          content: service.model.text,
          syntaxStyle,
          fg: theme.primary,
          bg: theme.background,
          width: "100%",
          conceal: true,
          concealCode: false,
          tableOptions: { style: "columns", borders: false, outerBorder: false },
        }),
      )
      root.add(preview)
      preview.focus()
    }

    const showProposalPreview = (patch: string): void => {
      closeOverlay()
      root.remove(editor)
      preview = new ScrollBoxRenderable(renderer!, {
        id: "proposal-preview",
        width: "100%",
        height: "100%",
        scrollY: true,
        scrollX: false,
        backgroundColor: theme.background,
        verticalScrollbarOptions: { visible: false },
      })
      const chunks = patch.replaceAll("\r\n", "\n").split("\n").flatMap((line, index) => {
        const color =
          line.startsWith("+") && !line.startsWith("+++")
            ? theme.added
            : line.startsWith("-") && !line.startsWith("---")
              ? theme.removed
              : line.startsWith("@@")
                ? theme.accent
                : theme.secondary
        return index === 0 ? [fg(color)(line)] : [fg(theme.background)("\n"), fg(color)(line)]
      })
      preview.add(
        new TextRenderable(renderer!, {
          content: new StyledText(chunks),
          width: "100%",
          height: "auto",
          selectable: true,
        }),
      )
      root.add(preview)
      preview.focus()
    }

    const commands = (): Command[] => {
      const base: Command[] = [
        { label: "find", run: find },
        { label: "replace", run: replace },
        {
          label: "go to line",
          run: () => prompt("line", (value) => editor.setCursor(Math.max(0, Number.parseInt(value, 10) - 1), 0)),
        },
        {
          label: editor.wrapMode === "none" ? "enable word wrap" : "disable word wrap",
          run: () => {
            editor.wrapMode = editor.wrapMode === "none" ? "word" : "none"
          },
        },
        { label: "preview markdown", run: showPreview },
        { label: "undo my change", run: undo },
        { label: "redo my change", run: redo },
        { label: "save", run: flush },
        { label: "quit", run: finish },
      ]
      const proposal = service.pendingProposals[0]
      if (proposal) {
        base.unshift(
          { label: `preview proposal from ${proposal.actor}`, run: () => showProposalPreview(proposal.patch) },
          {
            label: `accept proposal from ${proposal.actor}`,
            run: () => {
              try {
                service.acceptProposal(proposal.id)
              } catch (error) {
                showError(error instanceof Error ? error.message : String(error))
              }
            },
          },
          { label: `reject proposal from ${proposal.actor}`, run: () => void service.rejectProposal(proposal.id) },
        )
      }
      return base
    }

    const openCommands = (): void => {
      if (overlay) {
        closeOverlay()
        return
      }
      const commandOverlay = new CommandOverlay(renderer!, theme, commands, () => closeOverlay())
      overlay = commandOverlay.box
      root.add(overlay)
      commandOverlay.focus()
    }

    editor.callbacks = {
      quit: finish,
      commands: openCommands,
      save: flush,
      undo,
      redo,
      closeOverlay,
    }

    service.subscribe((event) => {
      if (closing) return
      const transactionId = event.transaction?.id
      if (!transactionId || event.transaction?.actor.startsWith("human")) return
      const transaction = service.model.history.find((candidate) => candidate.id === transactionId)
      if (transaction) applyTransactionToEditor(transaction)
    })
    service.subscribeSaveError((error) => {
      if (closing) return
      if (error) reportSaveError(error.message)
      else clearError()
    })

    renderer.keyInput.on("keypress", (key) => {
      const name = key.name.toLowerCase()
      if (key.ctrl && name === "c") {
        key.preventDefault()
        finish()
        return
      }
      if (preview && (name === "escape" || (key.meta && name === "x"))) {
        key.preventDefault()
        closeOverlay()
      }
    })

    root.add(editor)
    renderer.root.add(root)
    editor.focus()
    renderer.start()
    await finished
    flush()
    renderer.destroy()
    renderer = null
  } finally {
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

function markdownStyle(theme: EditorTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.primary },
    text: { fg: theme.primary },
    "markup.heading": { fg: theme.primary, bold: true },
    "markup.bold": { fg: theme.primary, bold: true },
    "markup.italic": { fg: theme.secondary, italic: true },
    "markup.raw": { fg: theme.dim },
    "markup.link": { fg: theme.secondary },
    comment: { fg: theme.dim },
    keyword: { fg: theme.accent },
    string: { fg: theme.secondary },
    number: { fg: theme.secondary },
  })
}
