import { expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DocumentModel } from "../src/document/model.js"
import {
  DocumentTextarea,
  EXIT_CONFIRMATION_TIMEOUT_MS,
  ExitConfirmation,
  TRANSIENT_NOTICE_TIMEOUT_MS,
  TransientNotice,
  applyTransactionToEditorState,
} from "../src/tui/editor.js"

async function withEditor(
  initialValue: string,
  cursor: number,
  run: (editor: DocumentTextarea, setup: TestRendererSetup) => Promise<void>,
): Promise<void> {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const editor = new DocumentTextarea(setup.renderer, {
    width: "100%",
    height: "100%",
    initialValue,
  })
  setup.renderer.root.add(editor)
  editor.focus()
  editor.cursorOffset = cursor
  await setup.renderOnce()
  try {
    await run(editor, setup)
  } finally {
    setup.renderer.destroy()
  }
}

async function press(
  setup: TestRendererSetup,
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; super?: boolean } = {},
): Promise<void> {
  setup.mockInput.pressKey(name, modifiers)
  await setup.flush()
}

test("ctrl+k alternates killing line content and its newline, then yanks the chain", async () => {
  await withEditor("alpha\nbeta\n", 0, async (editor, setup) => {
    await press(setup, "k", { ctrl: true })
    expect(editor.plainText).toBe("\nbeta\n")

    await press(setup, "k", { ctrl: true })
    expect(editor.plainText).toBe("beta\n")

    await press(setup, "k", { ctrl: true })
    await press(setup, "k", { ctrl: true })
    expect(editor.plainText).toBe("")

    await press(setup, "y", { ctrl: true })
    expect(editor.plainText).toBe("alpha\nbeta\n")
  })
})

test("ctrl+u stops at the logical line start and preserves its backward kill for yank", async () => {
  await withEditor("alpha\nbeta", 8, async (editor, setup) => {
    await press(setup, "u", { ctrl: true })
    expect(editor.plainText).toBe("alpha\nta")
    expect(editor.cursorOffset).toBe(6)

    await press(setup, "u", { ctrl: true })
    expect(editor.plainText).toBe("alpha\nta")

    await press(setup, "y", { ctrl: true })
    expect(editor.plainText).toBe("alpha\nbeta")
  })
})

test("consecutive ctrl+w kills whitespace-delimited words and yanks them in source order", async () => {
  await withEditor("one two-three four", 18, async (editor, setup) => {
    await press(setup, "w", { ctrl: true })
    expect(editor.plainText).toBe("one two-three ")

    await press(setup, "w", { ctrl: true })
    expect(editor.plainText).toBe("one ")

    await press(setup, "y", { ctrl: true })
    expect(editor.plainText).toBe("one two-three four")
  })
})

test("alt word kills participate in the same kill and yank behavior", async () => {
  await withEditor("one two-three", 4, async (editor, setup) => {
    await press(setup, "d", { meta: true })
    expect(editor.plainText).toBe("one -three")
    await press(setup, "y", { ctrl: true })
    expect(editor.plainText).toBe("one two-three")

    editor.cursorOffset = editor.plainText.length
    await press(setup, "BACKSPACE", { meta: true })
    expect(editor.plainText).toBe("one two-")
    await press(setup, "y", { ctrl: true })
    expect(editor.plainText).toBe("one two-three")
  })
})

test("readline logical-line and buffer motions do not spill across boundaries", async () => {
  await withEditor("alpha\nbeta", 5, async (editor, setup) => {
    await press(setup, "e", { ctrl: true })
    expect(editor.cursorOffset).toBe(5)

    editor.cursorOffset = 6
    await press(setup, "a", { ctrl: true })
    expect(editor.cursorOffset).toBe(6)
    await press(setup, "e", { ctrl: true })
    expect(editor.cursorOffset).toBe(10)

    await press(setup, "<", { meta: true })
    expect(editor.cursorOffset).toBe(0)
    await press(setup, ">", { meta: true })
    expect(editor.cursorOffset).toBe(10)

    editor.cursorOffset = 2
    await press(setup, "n", { ctrl: true })
    expect(editor.cursorOffset).toBe(8)
    await press(setup, "p", { ctrl: true })
    expect(editor.cursorOffset).toBe(2)
    await press(setup, "f", { ctrl: true })
    await press(setup, "b", { ctrl: true })
    expect(editor.cursorOffset).toBe(2)
  })
})

test("readline transpose and application undo/redo chords remain wired", async () => {
  await withEditor("ab one two", 2, async (editor, setup) => {
    let undos = 0
    let redos = 0
    editor.callbacks = {
      quit: () => {},
      undo: () => {
        undos++
      },
      redo: () => {
        redos++
      },
    }

    await press(setup, "t", { ctrl: true })
    expect(editor.plainText).toBe("ba one two")
    editor.cursorOffset = editor.plainText.length
    await press(setup, "t", { meta: true })
    expect(editor.plainText).toBe("ba two one")

    await press(setup, "-", { ctrl: true })
    await press(setup, ".", { ctrl: true })
    expect({ undos, redos }).toEqual({ undos: 1, redos: 1 })
  })
})

test("ctrl+c requires a second press inside the fmx confirmation window", async () => {
  expect(EXIT_CONFIRMATION_TIMEOUT_MS).toBe(2_000)
  const armed: boolean[] = []
  let quits = 0
  const confirmation = new ExitConfirmation(
    (value) => armed.push(value),
    () => quits++,
    20,
  )

  await withEditor("still here", 4, async (editor, setup) => {
    editor.callbacks = {
      quit: () => confirmation.request(),
      undo: () => {},
      redo: () => {},
    }

    await press(setup, "c", { ctrl: true })
    expect({ armed, quits, text: editor.plainText }).toEqual({
      armed: [true],
      quits: 0,
      text: "still here",
    })

    await Bun.sleep(30)
    expect({ armed, quits }).toEqual({ armed: [true, false], quits: 0 })

    await press(setup, "c", { ctrl: true })
    await press(setup, "c", { ctrl: true })
    expect({ armed, quits, text: editor.plainText }).toEqual({
      armed: [true, false, true, false],
      quits: 1,
      text: "still here",
    })
  })

  confirmation.cancel()
})

test("ordinary error notices clear after the transient notice window", async () => {
  expect(TRANSIENT_NOTICE_TIMEOUT_MS).toBe(2_000)
  const messages: Array<string | null> = []
  const notice = new TransientNotice((message) => messages.push(message), 20)

  notice.show("first")
  notice.show("second")
  expect(messages).toEqual(["first", "second"])
  await Bun.sleep(30)
  expect(messages).toEqual(["first", "second", null])
  notice.cancel()
})

test("an agent Transaction preserves logical cursor, selection, and viewport", async () => {
  const initial = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")
  const selectedStart = initial.indexOf("line 20")
  const inserted = "agent line\n"
  const model = new DocumentModel(initial)
  const result = model.apply({
    actor: "assistant",
    baseRevision: model.revision,
    edits: [{ start: 0, end: 0, text: inserted }],
  })
  expect(result.transaction).not.toBeNull()

  await withEditor(initial, selectedStart, async (editor) => {
    editor.setSelection(selectedStart, selectedStart + "line 20".length)
    editor.cursorOffset = selectedStart + "line 20".length
    editor.editorView.setViewport(0, 8, 80, 12, false)
    const viewport = editor.editorView.getViewport()

    applyTransactionToEditorState(editor, model.text, result.transaction!)

    expect(editor.plainText).toBe(inserted + initial)
    expect(editor.cursorOffset).toBe(selectedStart + "line 20".length + inserted.length)
    expect(editor.getSelection()).toEqual({
      start: selectedStart + inserted.length,
      end: selectedStart + "line 20".length + inserted.length,
    })
    expect(editor.editorView.getViewport()).toEqual(viewport)
  })
})
