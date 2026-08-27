import { describe, expect, test } from "bun:test"
import { applyEdits, deriveSingleEdit, invertEdits, transformEdits } from "../src/document/edits.js"

describe("text edits", () => {
  test("derives and inverts a replacement", () => {
    const before = "alpha beta gamma"
    const after = "alpha human gamma"
    const edit = deriveSingleEdit(before, after)
    expect(edit).not.toBeNull()
    expect(applyEdits(before, [edit!])).toBe(after)
    expect(applyEdits(after, invertEdits(before, [edit!]))).toBe(before)
  })

  test("applies several ranges in base coordinates", () => {
    expect(
      applyEdits("one two three", [
        { start: 0, end: 3, text: "1" },
        { start: 8, end: 13, text: "3" },
      ]),
    ).toBe("1 two 3")
  })

  test("moves a stale disjoint edit through intervening work", () => {
    const transformed = transformEdits([{ start: 6, end: 10, text: "BETA" }], [{ start: 0, end: 0, text: "new " }])
    expect(transformed.conflict).toBeNull()
    expect(transformed.edits).toEqual([{ start: 10, end: 14, text: "BETA" }])
  })

  test("refuses overlapping work", () => {
    const transformed = transformEdits([{ start: 3, end: 8, text: "agent" }], [{ start: 5, end: 6, text: "human" }])
    expect(transformed.conflict).not.toBeNull()
  })

  test("preserves unicode content exactly", () => {
    const before = "👩🏽‍💻 writes café\n"
    const after = "👩🏽‍💻 writes careful café\n"
    const edit = deriveSingleEdit(before, after)!
    expect(applyEdits(before, [edit])).toBe(after)
    expect(applyEdits(after, invertEdits(before, [edit]))).toBe(before)
  })
})
