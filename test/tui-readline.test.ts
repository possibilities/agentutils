import { expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DocumentTextarea } from "../src/tui/editor.js"

async function withEditor(
  initialValue: string,
  cursor: number,
  run: (editor: DocumentTextarea, setup: TestRendererSetup) => Promise<void>,
): Promise<void> {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
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
      commands: () => {},
      save: () => {},
      undo: () => {
        undos++
      },
      redo: () => {
        redos++
      },
      closeOverlay: () => false,
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
