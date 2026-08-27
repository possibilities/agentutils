import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DomainError } from "../src/errors.js"
import { DocumentLock, type DocumentPaths } from "../src/session/paths.js"

const roots: string[] = []
const pathsToClean: DocumentPaths[] = []

afterEach(() => {
  for (const paths of pathsToClean.splice(0)) rmSync(paths.lock, { recursive: true, force: true })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function documentPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `agenteditor-lock-${name}-`))
  roots.push(root)
  return join(root, "doc.md")
}

test("refuses an unverifiable lock instead of deleting it", () => {
  const lock = new DocumentLock(documentPath("unverifiable"))
  pathsToClean.push(lock.paths)
  mkdirSync(lock.paths.lock, { mode: 0o700 })

  expect(() => lock.acquire()).toThrow(DomainError)
  expect(existsSync(lock.paths.lock)).toBe(true)
  expect(existsSync(lock.paths.owner)).toBe(false)
})

test("refuses a lock held by a live process", () => {
  const document = documentPath("live")
  const first = new DocumentLock(document)
  pathsToClean.push(first.paths)
  first.acquire()
  const second = new DocumentLock(document)

  try {
    expect(() => second.acquire()).toThrow("already held by another process")
    expect(JSON.parse(readFileSync(first.paths.owner, "utf8")).token).toBe(first.token)
  } finally {
    first.release()
  }
})

test("atomically replaces a lock whose recorded process is gone", () => {
  const lock = new DocumentLock(documentPath("stale"))
  pathsToClean.push(lock.paths)
  mkdirSync(lock.paths.lock, { mode: 0o700 })
  writeFileSync(lock.paths.owner, JSON.stringify({ pid: 2_147_483_647, token: "stale" }), { mode: 0o600 })

  lock.acquire()
  try {
    expect(JSON.parse(readFileSync(lock.paths.owner, "utf8")).token).toBe(lock.token)
  } finally {
    lock.release()
  }
})
