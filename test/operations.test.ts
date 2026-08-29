import { describe, expect, test } from "bun:test"
import { DomainError } from "../src/errors.js"
import { editsFromOperations } from "../src/document/operations.js"
import { applyEdits } from "../src/document/edits.js"

describe("exact-text operations", () => {
  test("builds one atomic edit set from semantic operations", () => {
    const before = "# Prompt\n\nOld paragraph.\n\n## Constraints\nShort.\n"
    const edits = editsFromOperations(before, [
      { kind: "replace", target: "Old paragraph.", text: "New paragraph." },
      { kind: "insert_after", target: "## Constraints", text: "\n\nBe precise." },
      { kind: "delete", target: "Short." },
    ])

    expect(applyEdits(before, edits)).toBe(
      "# Prompt\n\nNew paragraph.\n\n## Constraints\n\nBe precise.\n\n",
    )
  })

  test("refuses missing, ambiguous, and overlapping targets with stable codes", () => {
    expectError(
      () => editsFromOperations("one", [{ kind: "delete", target: "two" }]),
      "edit_target_not_found",
    )
    expectError(
      () => editsFromOperations("same same", [{ kind: "delete", target: "same" }]),
      "ambiguous_edit",
    )
    expectError(
      () => editsFromOperations("aaa", [{ kind: "delete", target: "aa" }]),
      "ambiguous_edit",
    )
    expectError(
      () =>
        editsFromOperations("alpha beta", [
          { kind: "replace", target: "alpha beta", text: "all" },
          { kind: "delete", target: "beta" },
        ]),
      "bad_request",
    )
  })
})

function expectError(operation: () => unknown, code: DomainError["code"]): void {
  try {
    operation()
    throw new Error("expected operation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe(code)
  }
}
