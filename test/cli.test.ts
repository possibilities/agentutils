import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentPaths } from "../src/session/paths.js"

const roots: string[] = []
const journals: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const journal of journals.splice(0)) if (existsSync(journal)) rmSync(journal)
})

async function cli(args: string[], stdin = ""): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.write(stdin)
  child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("agent CLI", () => {
  test("creates, reads, patches, and guards a Document", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-cli-"))
    roots.push(root)
    const path = join(root, "notes.md")
    const created = await cli(["write", path, "--create", "--json"], "alpha\nbeta\n")
    expect(created.exitCode).toBe(0)
    journals.push(documentPaths(realpathSync(path)).journal)
    const createdEnvelope = JSON.parse(created.stdout)
    const base = createdEnvelope.data.revision as string

    const read = await cli(["read", path, "--json"])
    expect(JSON.parse(read.stdout).data.content).toBe("alpha\nbeta\n")

    const patched = await cli(
      ["apply", path, "--base", base, "--json"],
      "@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n",
    )
    expect(patched.exitCode).toBe(0)
    expect(JSON.parse(patched.stdout).data.transaction.rebased).toBe(false)
    const afterPatch = await cli(["read", path, "--json"])
    expect(JSON.parse(afterPatch.stdout).data.content).toBe("alpha\nBETA\n")

    const reservedActor = await cli(
      ["apply", path, "--base", JSON.parse(patched.stdout).data.revision, "--actor", "human-agent", "--json"],
      "@@ -1,2 +1,2 @@\n alpha\n-BETA\n+beta\n",
    )
    expect(reservedActor.exitCode).toBe(1)
    expect(JSON.parse(reservedActor.stdout).error.code).toBe("bad_request")

    const stale = await cli(["write", path, "--base", base, "--json"], "blind replacement\n")
    expect(stale.exitCode).toBe(1)
    expect(JSON.parse(stale.stdout).error.code).toBe("stale_revision")
  })

  test("requires explicit creation for a missing Document", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-missing-"))
    roots.push(root)
    const path = join(root, "missing.md")
    const emptyRevision = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    const result = await cli(["write", path, "--base", emptyRevision, "--json"], "content\n")
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).error.code).toBe("document_not_found")
    expect(existsSync(path)).toBe(false)
  })

  test("can explicitly create an empty Document", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenteditor-empty-"))
    roots.push(root)
    const path = join(root, "empty.md")
    const result = await cli(["write", path, "--create", "--json"])
    expect(result.exitCode).toBe(0)
    expect(existsSync(path)).toBe(true)
    journals.push(documentPaths(realpathSync(path)).journal)
    const ranged = await cli(["read", path, "--lines", "1:1", "--json"])
    expect(JSON.parse(ranged.stdout).data.range).toEqual({ start: 0, end: 0, total: 0 })
  })
})
