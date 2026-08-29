#!/usr/bin/env bun
import { runEditor } from "./editor.js"

class UsageError extends Error {}

function usage(): string {
  return `agentutils — focused utilities for working with agents

Usage:
  agentutils <utility>

Utilities:
  editor    Open the collaborative Document Surface

Run "agentutils <utility> --help" for utility-specific help.`
}

function editorUsage(): string {
  return `agentutils editor — a singleton collaborative Document Surface

Usage:
  agentutils editor

Agent control is available only through MCP at http://127.0.0.1:7332/mcp.`
}

async function run(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 1 && isHelp(args[0])) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  const [utility, ...utilityArgs] = args
  if (utility === undefined) throw new UsageError("a utility is required")
  if (utility !== "editor") throw new UsageError("unknown utility")

  if (utilityArgs.length === 1 && isHelp(utilityArgs[0])) {
    process.stdout.write(`${editorUsage()}\n`)
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
    process.stderr.write(`agentutils: ${error.message}\n\n${usage()}\n`)
    process.exitCode = 2
  } else {
    process.stderr.write("agentutils: unable to start the Surface\n")
    process.exitCode = 1
  }
}
