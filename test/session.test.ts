import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeRequest } from "../src/commands/execute.js"
import { loadJournal } from "../src/document/journal.js"
import { DocumentPersistence, loadDocument } from "../src/document/persistence.js"
import { SessionServer } from "../src/session/ipc.js"
import { DocumentLock } from "../src/session/paths.js"
import { DocumentService } from "../src/session/service.js"

const roots: string[] = []
const journals: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const journal of journals.splice(0)) if (existsSync(journal)) rmSync(journal)
})

describe("live Session", () => {
  test("rebases a CLI Transaction around live human input", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-session-"))
    roots.push(root)
    const path = join(root, "doc.md")
    writeFileSync(path, "alpha\nbeta\n")
    const loaded = loadDocument(path)
    const lock = new DocumentLock(loaded.path)
    journals.push(lock.paths.journal)
    lock.acquire()
    const service = new DocumentService({
      model: loadJournal(lock.paths.journal, loaded.text),
      persistence: new DocumentPersistence(loaded),
      journalPath: lock.paths.journal,
    })
    const server = new SessionServer(service, lock)
    const observedActors: string[] = []
    service.subscribe((transaction) => observedActors.push(transaction.actor))
    await server.start()
    try {
      const read = await executeRequest<{ revision: string; content: string }>(path, { kind: "read" })
      expect(read.ok).toBe(true)
      if (!read.ok) return
      const base = read.data.revision

      service.applyHumanText("intro\nalpha\nbeta\n", { start: 0, end: 6 })
      const applied = await executeRequest<{ transaction: { rebased: boolean } }>(path, {
        kind: "apply",
        baseRevision: base,
        patch: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n",
      })
      expect(applied.ok).toBe(true)
      if (applied.ok) {
        expect(applied.data.transaction.rebased).toBe(true)
      }
      expect(service.model.text).toBe("intro\nalpha\nBETA\n")
      expect(observedActors).toEqual(["human", "assistant"])
    } finally {
      service.close()
      await server.close()
      lock.release()
    }
  })

  test("keeps disk and the live Document unchanged when journal publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-journal-failure-"))
    roots.push(root)
    const path = join(root, "doc.md")
    writeFileSync(path, "old\n")
    const loaded = loadDocument(path)
    const journalPath = join(root, "missing", "journal.json")
    const service = new DocumentService({
      model: loadJournal(journalPath, loaded.text),
      persistence: new DocumentPersistence(loaded),
      journalPath,
    })
    const baseRevision = service.model.revision
    const saveErrors: Array<Error | null> = []
    service.subscribeSaveError((error) => saveErrors.push(error))

    await expect(
      service.request({ kind: "write", baseRevision, content: "new\n" }),
    ).rejects.toThrow("ENOENT")
    expect(readFileSync(path, "utf8")).toBe("old\n")
    expect(service.model.text).toBe("old\n")
    expect(saveErrors).toHaveLength(1)
    expect(saveErrors[0]).toBeInstanceOf(Error)

    mkdirSync(join(root, "missing"))
    await service.request({ kind: "write", baseRevision, content: "new\n" })
    expect(readFileSync(path, "utf8")).toBe("new\n")
    expect(service.model.text).toBe("new\n")
    expect(saveErrors.at(-1)).toBeNull()
  })
})
