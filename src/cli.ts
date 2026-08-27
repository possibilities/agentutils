#!/usr/bin/env bun
import { executeRequest } from "./commands/execute.js"
import { runEditor } from "./tui/editor.js"
import type { Envelope } from "./protocol.js"
import type { ServiceRequest } from "./session/service.js"

const COMMANDS = new Set(["edit", "read", "apply", "write", "status", "history", "help"])

class UsageError extends Error {}

function usage(): string {
  return `agenteditor — a human-and-agent text editor

Usage:
  agenteditor PATH
  agenteditor edit PATH
  agenteditor read PATH [--lines START:END] [--json]
  agenteditor apply PATH --base REV [--actor NAME] [--message TEXT] [--json]
  agenteditor write PATH (--base REV | --create) [--actor NAME] [--message TEXT] [--json]
  agenteditor status PATH [--json]
  agenteditor history PATH [--json]

Mutation bodies are read from stdin. apply accepts one unified diff; write
accepts the complete Document. Existing Documents never have a force path.`
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag)
  if (index === -1) return false
  args.splice(index, 1)
  return true
}

function takeValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new UsageError(`${flag} requires a value`)
  args.splice(index, 2)
  return value
}

function requireValue(args: string[], flag: string): string {
  const value = takeValue(args, flag)
  if (value === undefined) throw new UsageError(`${flag} is required`)
  return value
}

function requirePath(args: string[]): string {
  const path = args.shift()
  if (!path || path.startsWith("--")) throw new UsageError("a Document path is required")
  return path
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new UsageError(`unexpected argument: ${args[0]}`)
}

function parseLines(value: string): { start: number; end: number } {
  const match = /^(\d+):(\d+)$/.exec(value)
  if (!match) throw new UsageError("--lines must be START:END with one-based line numbers")
  const start = Number(match[1])
  const end = Number(match[2])
  if (start < 1 || end < start) throw new UsageError("--lines end must be at or after start")
  return { start, end }
}

function actor(args: string[]): string {
  return takeValue(args, "--actor") ?? process.env.AGENTEDITOR_ACTOR ?? `agent:${process.pid}`
}

function emit(envelope: Envelope<unknown>, json: boolean, command: string): number {
  if (!envelope.ok) {
    if (json) process.stdout.write(`${JSON.stringify(envelope)}\n`)
    else {
      process.stderr.write(`agenteditor: ${envelope.error.message}\n`)
      if (envelope.error.recovery) process.stderr.write(`recovery: ${envelope.error.recovery}\n`)
    }
    return 1
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
    return 0
  }
  const data = envelope.data as Record<string, unknown>
  if (command === "read") process.stdout.write(String(data.content ?? ""))
  else if ("revision" in data) {
    const transaction = data.transaction as { id?: string; rebased?: boolean } | null | undefined
    process.stdout.write(`${String(data.revision)}${transaction?.id ? ` ${transaction.id}` : ""}${transaction?.rebased ? " rebased" : ""}\n`)
  } else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  return 0
}

async function run(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  let command = args[0]!
  if (!COMMANDS.has(command)) command = "edit"
  else args.shift()

  if (command === "edit") {
    const path = requirePath(args)
    assertNoArgs(args)
    await runEditor(path)
    return 0
  }

  const path = requirePath(args)
  const json = takeFlag(args, "--json")
  let request: ServiceRequest

  switch (command) {
    case "read": {
      const linesValue = takeValue(args, "--lines")
      request = { kind: "read", ...(linesValue === undefined ? {} : { lines: parseLines(linesValue) }) }
      break
    }
    case "apply": {
      const baseRevision = requireValue(args, "--base")
      const requestActor = actor(args)
      const message = takeValue(args, "--message")
      const patch = await Bun.stdin.text()
      request = {
        kind: "apply",
        baseRevision,
        patch,
        actor: requestActor,
        ...(message === undefined ? {} : { message }),
      }
      break
    }
    case "write": {
      const create = takeFlag(args, "--create")
      const baseRevision = takeValue(args, "--base")
      if (create === (baseRevision !== undefined)) {
        throw new UsageError("write requires exactly one of --create or --base REV")
      }
      const requestActor = actor(args)
      const message = takeValue(args, "--message")
      const content = await Bun.stdin.text()
      request = {
        kind: "write",
        content,
        actor: requestActor,
        create,
        ...(baseRevision === undefined ? {} : { baseRevision }),
        ...(message === undefined ? {} : { message }),
      }
      break
    }
    case "status":
      request = { kind: "status" }
      break
    case "history":
      request = { kind: "history" }
      break
    default:
      throw new UsageError(`unknown command: ${command}`)
  }

  assertNoArgs(args)
  const envelope = await executeRequest<Record<string, unknown>>(path, request, {
    allowMissing: command === "write",
  })
  return emit(envelope, json, command)
}

try {
  process.exitCode = await run()
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`agenteditor: ${error.message}\n\n${usage()}\n`)
    process.exitCode = 2
  } else {
    process.stderr.write(`agenteditor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
