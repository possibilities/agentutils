import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ModelCatalog } from "../src/catalog.js"
import { DomainError } from "../src/errors.js"
import { DocumentStore } from "../src/storage/database.js"
import { SurfaceService } from "../src/surface/service.js"
import { makeTempDir, removeTempDirs } from "./helpers.js"

afterEach(removeTempDirs)

const catalog: ModelCatalog = {
  source: "test",
  loadedAt: "2026-08-29T00:00:00.000Z",
  error: null,
  models: [
    { id: "gpt-primary", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
    { id: "gpt-fast", defaultEffort: "low", efforts: ["low", "medium"] },
  ],
}

describe("SurfaceService", () => {
  test("persists opaque Documents, focus, mode, Configuration, and view state", () => {
    const databasePath = join(makeTempDir("agentutils-surface-"), "state.sqlite3")
    let service = new SurfaceService({ store: new DocumentStore(databasePath), catalog })

    expect(service.getSurfaceState().mode).toBe("standby")
    const created = service.createDocument({ title: "  Release prompt  ", content: "Draft" })
    expect(created.document_id).toMatch(/^doc_[0-9a-f]{32}$/)
    expect(created.document_id).not.toContain(databasePath)
    expect(created.title).toBe("Release prompt")
    expect(created.model).toBe("gpt-primary")
    expect(created.effort).toBe("medium")

    service.setFocusedView({
      cursor: 3,
      selectionStart: 1,
      selectionEnd: 4,
      viewportX: 2,
      viewportY: 5,
    })
    service.setConfiguration({ model: "gpt-primary", effort: "high" })
    service.setSurfaceMode("document_configuration")
    service.flush()
    service.close()

    service = new SurfaceService({ store: new DocumentStore(databasePath), catalog })
    const restored = service.getSurfaceState()
    expect(restored.mode).toBe("document_configuration")
    expect(restored.focused_document).toMatchObject({
      document_id: created.document_id,
      title: "Release prompt",
      content: "Draft",
      model: "gpt-primary",
      effort: "high",
      configuration_valid: true,
    })
    expect(service.getFocusedView()).toEqual({
      cursor: 3,
      selectionStart: 1,
      selectionEnd: 4,
      viewportX: 2,
      viewportY: 5,
    })
    service.close()
  })

  test("rebases disjoint assistant work durably without changing focus or human view", () => {
    const databasePath = join(makeTempDir("agentutils-transactions-"), "state.sqlite3")
    const service = new SurfaceService({ store: new DocumentStore(databasePath), catalog })
    const first = service.createDocument({ title: "First", content: "alpha\nbeta\ngamma\n" })
    const baseRevision = first.revision

    service.applyHumanText("alpha\nbeta human\ngamma\n", { start: 6, end: 17 })
    service.setFocusedView({
      cursor: 17,
      selectionStart: 17,
      selectionEnd: 22,
      viewportX: 0,
      viewportY: 3,
    })

    const mutation = service.editDocument({
      baseRevision,
      operations: [{ kind: "insert_before", target: "alpha", text: "START\n" }],
    })
    expect(mutation).toMatchObject({ changed: true })
    expect((mutation.transaction as { rebased: boolean }).rebased).toBe(true)
    expect(service.getSurfaceState().focused_document?.content).toBe("START\nalpha\nbeta human\ngamma\n")
    expect(service.getFocusedView()).toEqual({
      cursor: 23,
      selectionStart: 23,
      selectionEnd: 28,
      viewportX: 0,
      viewportY: 3,
    })

    const second = service.createDocument({ title: "Second", content: "second", focus: false })
    service.editDocument({
      documentId: second.document_id,
      baseRevision: second.revision,
      operations: [{ kind: "replace", target: "second", text: "changed" }],
    })
    expect(service.getSurfaceState(false).focused_document?.document_id).toBe(first.document_id)

    const independentReader = new DocumentStore(databasePath)
    expect(independentReader.getDocument(first.document_id).content).toBe("START\nalpha\nbeta human\ngamma\n")
    expect(independentReader.getDocument(second.document_id).content).toBe("changed")
    independentReader.close()
    service.close()
  })

  test("refuses Active-region overlap, stale replacement, and invalid Configuration", () => {
    const service = new SurfaceService({ store: new DocumentStore(":memory:"), catalog })
    const document = service.createDocument({ title: "Guarded", content: "alpha\nbeta\n" })
    service.setActiveRegion(6, 11)

    expectDomainError(
      () =>
        service.editDocument({
          baseRevision: document.revision,
          operations: [{ kind: "replace", target: "beta", text: "changed" }],
        }),
      "edit_conflict",
    )
    service.applyHumanText("alpha\nbeta!\n")
    expectDomainError(
      () => service.replaceDocument({ baseRevision: document.revision, content: "blind replacement" }),
      "stale_revision",
    )
    expectDomainError(
      () => service.setConfiguration({ model: "gpt-fast", effort: "high" }),
      "invalid_configuration",
    )
    service.close()
  })

  test("reads bounded one-based line ranges", () => {
    const service = new SurfaceService({ store: new DocumentStore(":memory:"), catalog })
    service.createDocument({ title: "Lines", content: "one\ntwo\nthree\n" })
    expect(service.readDocument({ lines: { start: 2, end: 99 } })).toMatchObject({
      range: { start: 2, end: 3, total: 3 },
      content: "two\nthree",
    })
    expect(service.readDocument({ lines: { start: 99, end: 120 } })).toMatchObject({
      range: { start: 0, end: 0, total: 3 },
      content: "",
    })
    service.close()
  })
})

function expectDomainError(operation: () => unknown, code: DomainError["code"]): void {
  try {
    operation()
    throw new Error("expected operation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe(code)
  }
}
