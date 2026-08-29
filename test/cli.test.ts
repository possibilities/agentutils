import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { makeTempDir } from "./helpers.js"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

describe("CLI boundary", () => {
  test("suite help lists the available utilities", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli(flag)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Usage:\n  agentutils <utility>")
      expect(result.stdout).toContain("editor    Open the collaborative Document Surface")
      expect(result.stdout).not.toContain("http://127.0.0.1:7332/mcp")
    }
  })

  test("editor help describes only the singleton Surface and MCP endpoint", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli("editor", flag)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Usage:\n  agentutils editor")
      expect(result.stdout).toContain("http://127.0.0.1:7332/mcp")
      expect(result.stdout).not.toContain("PATH")
    }
  })

  test("missing and unknown utilities are rejected without touching storage", async () => {
    const stateDirectory = join(makeTempDir("agentutils-cli-"), "state-must-not-exist")
    const privateInput = "/private/example/prompt.md"
    const invocations = [[], [privateInput], ["read"], ["help"]]

    for (const args of invocations) {
      const result = await runCli(...args, { AGENTUTILS_EDITOR_STATE_DIR: stateDirectory })
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("Usage:\n  agentutils <utility>")
      expect(result.stderr).not.toContain(privateInput)
    }
    expect(existsSync(stateDirectory)).toBe(false)
  })

  test("editor rejects paths and control commands without touching storage", async () => {
    const stateDirectory = join(makeTempDir("agentutils-editor-cli-"), "state-must-not-exist")
    const privateInput = "/private/example/prompt.md"
    const invocations = [
      ["editor", privateInput],
      ["editor", "edit", privateInput],
      ["editor", "read", privateInput, "--json"],
      ["editor", "apply", privateInput, "--base", "sha256:old"],
      ["editor", "write", privateInput, "--create"],
      ["editor", "help"],
    ]

    for (const args of invocations) {
      const result = await runCli(...args, { AGENTUTILS_EDITOR_STATE_DIR: stateDirectory })
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("editor does not accept paths or control commands")
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
