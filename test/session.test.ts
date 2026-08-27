import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
      sessionActive: true,
    })
    const server = new SessionServer(service, lock)
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
        actor: "agent:test",
      })
      expect(applied.ok).toBe(true)
      if (applied.ok) {
        expect(applied.data.transaction.rebased).toBe(true)
      }
      expect(service.model.text).toBe("intro\nalpha\nBETA\n")
    } finally {
      service.close()
      await server.close()
      lock.release()
    }
  })

  test("stages a Proposal without changing the Document", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-proposal-"))
    roots.push(root)
    const path = join(root, "doc.md")
    writeFileSync(path, "alpha\n")
    const loaded = loadDocument(path)
    const lock = new DocumentLock(loaded.path)
    journals.push(lock.paths.journal)
    lock.acquire()
    const service = new DocumentService({
      model: loadJournal(lock.paths.journal, loaded.text),
      persistence: new DocumentPersistence(loaded),
      journalPath: lock.paths.journal,
      sessionActive: true,
    })
    const server = new SessionServer(service, lock)
    await server.start()
    try {
      const proposed = await executeRequest<{ proposal: { id: string } }>(path, {
        kind: "apply",
        baseRevision: service.model.revision,
        patch: "@@ -1,1 +1,1 @@\n-alpha\n+ALPHA\n",
        actor: "agent:test",
        propose: true,
      })
      expect(proposed.ok).toBe(true)
      expect(service.model.text).toBe("alpha\n")
      expect(service.pendingProposals).toHaveLength(1)
      service.model.setActiveRegion(0, service.model.text.length, 60_000)
      service.acceptProposal(service.pendingProposals[0]!.id)
      expect(service.model.text).toBe("ALPHA\n")
    } finally {
      service.close()
      await server.close()
      lock.release()
    }
  })
})
