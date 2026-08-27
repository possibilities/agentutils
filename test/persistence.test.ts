import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DomainError } from "../src/errors.js"
import { DocumentPersistence, loadDocument } from "../src/document/persistence.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("DocumentPersistence", () => {
  test("writes atomically and notices outside changes", () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-persistence-"))
    roots.push(root)
    const path = join(root, "doc.md")
    writeFileSync(path, "one\n")
    const persistence = new DocumentPersistence(loadDocument(path))
    persistence.save("two\n")
    expect(readFileSync(path, "utf8")).toBe("two\n")
    writeFileSync(path, "outside\n")
    expect(() => persistence.save("three\n")).toThrow(DomainError)
    expect(readFileSync(path, "utf8")).toBe("outside\n")
  })

  test("refuses invalid UTF-8 instead of normalizing bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-encoding-"))
    roots.push(root)
    const path = join(root, "binary.txt")
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]))
    expect(() => loadDocument(path)).toThrow(/valid UTF-8/)
  })
})
