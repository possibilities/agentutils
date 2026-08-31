/**
 * The fleet agent contract: the one machine-readable self-description this
 * CLI publishes as `agentutils guide --json`. This file is authored once;
 * every rendered help surface (`--help`, `agentutils editor --help`) reads
 * it rather than carrying its own prose. See
 * ~/code/agentstart/config/agent-contract/README.md for the contract itself.
 */

import pkg from "../package.json" with { type: "json" }

const MCP_URL = "http://127.0.0.1:7332/mcp"

export interface AgentContract {
  contract_version: 1
  meta: {
    name: string
    version: string
    purpose: string
    audience: "operator"
  }
  commands: Array<{
    name: string
    summary: string
    audience: "operator" | "internal"
    mutates: boolean
    arguments: unknown[]
    guidance?: string
  }>
}

export function buildContract(): AgentContract {
  return {
    contract_version: 1,
    meta: {
      name: "agentutils",
      version: pkg.version,
      purpose:
        "A command suite for focused agent utilities. Its first utility, editor, is a singleton collaborative Document Surface: a human edits the focused Document in a bare terminal interface while agents create, resume, focus, read, and revise Documents through MCP.",
      audience: "operator",
    },
    commands: [
      {
        name: "editor",
        summary: "Open the collaborative Document Surface",
        audience: "operator",
        mutates: true,
        guidance: `A singleton collaborative Document Surface. A human runs this to open the TUI; agent control is available only through MCP at ${MCP_URL}. It takes no arguments — no paths, no control commands — and there is no automation surface beyond MCP.`,
        arguments: [],
      },
      {
        name: "guide",
        summary: "Print this machine-readable contract",
        audience: "internal",
        mutates: false,
        arguments: [],
      },
    ],
  }
}

export function buildEnvelope(): { schema_version: 1; ok: true; error: null; data: AgentContract } {
  return { schema_version: 1, ok: true, error: null, data: buildContract() }
}

function findCommand(name: string) {
  const command = buildContract().commands.find((c) => c.name === name)
  if (!command) throw new Error(`unknown command ${name}`)
  return command
}

export function renderSuiteHelp(): string {
  const contract = buildContract()
  const lines = contract.commands
    .filter((c) => c.audience !== "internal")
    .map((c) => `  ${c.name.padEnd(9)} ${c.summary}`)
  return `agentutils — ${firstSentence(contract.meta.purpose)}

Usage:
  agentutils <utility>

Utilities:
${lines.join("\n")}

Run "agentutils <utility> --help" for utility-specific help.`
}

export function renderEditorHelp(): string {
  const editor = findCommand("editor")
  return `agentutils editor — a singleton collaborative Document Surface

Usage:
  agentutils editor

${editor.guidance}`
}

function firstSentence(text: string): string {
  const index = text.indexOf(". ")
  return index === -1 ? text : text.slice(0, index + 1)
}
