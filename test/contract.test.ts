import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { buildEnvelope } from "../src/contract.js"

/**
 * `agentutils guide --json` is this CLI's half of the fleet agent contract
 * (~/code/agentstart/config/agent-contract/README.md). agentstart owns the
 * schema and the validator; this repo owns proving its own output conforms.
 */
const VALIDATOR = join(homedir(), "code", "agentstart", "scripts", "validate-agent-contract.ts")

describe("fleet agent contract", () => {
  test("guide --json conforms to the fleet agent contract schema", async () => {
    if (!existsSync(VALIDATOR)) {
      console.warn(`skipping: validator not found at ${VALIDATOR}`)
      return
    }
    const envelope = buildEnvelope()
    const tmp = join(
      globalThis.process.env["TMPDIR"] ?? "/tmp",
      `agentutils-guide-${globalThis.process.pid}-${Date.now()}.json`,
    )
    await Bun.write(tmp, JSON.stringify(envelope, null, 2))
    try {
      const result = Bun.spawnSync([VALIDATOR, "--file", tmp], { stdout: "pipe", stderr: "pipe" })
      const stderr = result.stderr.toString()
      expect(stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("conforms to version 1")
    } finally {
      await Bun.file(tmp).delete()
    }
  })

  test("every command declares an operator or internal audience", () => {
    const envelope = buildEnvelope()
    expect(envelope.data.meta.audience).toBe("operator")
    for (const command of envelope.data.commands) {
      expect(["operator", "internal"]).toContain(command.audience)
    }
  })

  test("guide --json matches the CLI's own emitted output", async () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts")
    const child = Bun.spawn([process.execPath, cli, "guide", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual(buildEnvelope())
  })
})
