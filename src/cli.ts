#!/usr/bin/env bun
import { runEditor } from "./editor.js"
import { buildEnvelope, renderEditorHelp, renderSuiteHelp } from "./contract.js"

class UsageError extends Error {}

async function run(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 1 && isHelp(args[0])) {
    process.stdout.write(`${renderSuiteHelp()}\n`)
    return 0
  }

  const [utility, ...utilityArgs] = args
  if (utility === undefined) throw new UsageError("a utility is required")

  if (utility === "guide") {
    process.stdout.write(`${JSON.stringify(buildEnvelope(), null, 2)}\n`)
    return 0
  }

  if (utility !== "editor") throw new UsageError("unknown utility")

  if (utilityArgs.length === 1 && isHelp(utilityArgs[0])) {
    process.stdout.write(`${renderEditorHelp()}\n`)
    return 0
  }
  if (utilityArgs.length > 0) {
    throw new UsageError("editor does not accept paths or control commands; use its MCP server")
  }

  return runEditor()
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h"
}

try {
  process.exitCode = await run()
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`agentutils: ${error.message}\n\n${renderSuiteHelp()}\n`)
    process.exitCode = 2
  } else {
    process.stderr.write("agentutils: unable to start the Surface\n")
    process.exitCode = 1
  }
}
