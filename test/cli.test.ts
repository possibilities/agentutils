import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { makeTempDir } from "./helpers.js"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

describe("CLI boundary", () => {
  test("help describes only the singleton Surface and MCP endpoint", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli(flag)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Usage:\n  agenteditor")
      expect(result.stdout).toContain("http://127.0.0.1:7332/mcp")
      expect(result.stdout).not.toContain("PATH")
    }
  })

  test("paths and former control commands are rejected without touching storage", async () => {
    const stateDirectory = join(makeTempDir("agenteditor-cli-"), "state-must-not-exist")
    const privateInput = "/private/example/prompt.md"
    const invocations = [
      [privateInput],
      ["edit", privateInput],
      ["read", privateInput, "--json"],
      ["apply", privateInput, "--base", "sha256:old"],
      ["write", privateInput, "--create"],
      ["help"],
    ]

    for (const args of invocations) {
      const result = await runCli(...args, { AGENTEDITOR_STATE_DIR: stateDirectory })
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("does not accept paths or control commands")
      expect(result.stderr).not.toContain(privateInput)
    }
    expect(existsSync(stateDirectory)).toBe(false)
  })
})

async function runCli(
  ...input: Array<string | Record<string, string>>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const maybeEnvironment = input.at(-1)
  const environment =
    typeof maybeEnvironment === "object" ? (input.pop() as Record<string, string>) : {}
  const child = Bun.spawn([process.execPath, cli, ...(input as string[])], {
    env: { ...globalThis.process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}
