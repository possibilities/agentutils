import { describe, expect, test } from "bun:test"
import { DomainError } from "../src/errors.js"
import { DocumentModel } from "../src/document/model.js"

describe("DocumentModel", () => {
  test("rebases non-overlapping Transactions", () => {
    const model = new DocumentModel("alpha\nbeta\ngamma\n")
    const base = model.revision
    model.apply({ actor: "human", baseRevision: base, edits: [{ start: 0, end: 0, text: "intro\n" }] })
    const agent = model.apply({ actor: "agent:test", baseRevision: base, edits: [{ start: 11, end: 16, text: "GAMMA" }] })
    expect(agent.transaction?.rebased).toBe(true)
    expect(model.text).toBe("intro\nalpha\nbeta\nGAMMA\n")
  })

  test("refuses an overlap with intervening work", () => {
    const model = new DocumentModel("alpha beta gamma")
    const base = model.revision
    model.apply({ actor: "human", baseRevision: base, edits: [{ start: 6, end: 10, text: "person" }] })
    expect(() =>
      model.apply({ actor: "agent:test", baseRevision: base, edits: [{ start: 8, end: 10, text: "AGENT" }] }),
    ).toThrow(DomainError)
  })

  test("protects the Active region", () => {
    const model = new DocumentModel("alpha\nbeta\n")
    model.setActiveRegion(0, 6, 60_000)
    expect(() =>
      model.apply({
        actor: "agent:test",
        baseRevision: model.revision,
        edits: [{ start: 1, end: 2, text: "X" }],
      }),
    ).toThrow(/Active region/)
  })

  test("undo rebases around later disjoint work", () => {
    const model = new DocumentModel("alpha beta gamma")
    const first = model.apply({
      actor: "agent:first",
      baseRevision: model.revision,
      edits: [{ start: 0, end: 5, text: "ALPHA" }],
    }).transaction!
    model.apply({
      actor: "agent:second",
      baseRevision: model.revision,
      edits: [{ start: 11, end: 16, text: "GAMMA" }],
    })
    model.undo(first.id, "agent:first", model.revision)
    expect(model.text).toBe("alpha beta GAMMA")
  })

  test("serializes enough history to continue rebasing", () => {
    const model = new DocumentModel("one two three")
    const base = model.revision
    model.apply({ actor: "human", baseRevision: base, edits: [{ start: 0, end: 3, text: "ONE" }] })
    const restored = DocumentModel.restore(model.text, model.serialize())
    restored.apply({ actor: "agent:test", baseRevision: base, edits: [{ start: 8, end: 13, text: "THREE" }] })
    expect(restored.text).toBe("ONE two THREE")
  })
})
