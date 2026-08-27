import { describe, expect, test } from "bun:test"
import { applyEdits } from "../src/document/edits.js"
import { editsFromUnifiedDiff } from "../src/document/unified-diff.js"

describe("unified diff", () => {
  test("converts a hunk to a guarded edit", () => {
    const base = "alpha\nbeta\ngamma\n"
    const patch = `--- a/doc.md
+++ b/doc.md
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`
    expect(applyEdits(base, editsFromUnifiedDiff(base, patch))).toBe("alpha\nBETA\ngamma\n")
  })

  test("keeps separated hunk changes separated", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n"
    const patch = `@@ -1,2 +1,2 @@
-one
+ONE
 two
@@ -4,2 +4,2 @@
 four
-five
+FIVE
`
    const edits = editsFromUnifiedDiff(base, patch)
    expect(edits).toHaveLength(2)
    expect(applyEdits(base, edits)).toBe("ONE\ntwo\nthree\nfour\nFIVE\n")
  })

  test("rejects stale context", () => {
    const patch = `@@ -1,1 +1,1 @@
-wrong
+right
`
    expect(() => editsFromUnifiedDiff("actual\n", patch)).toThrow(/does not match/)
  })
})
