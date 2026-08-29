#!/usr/bin/env bun
import { loadModelCatalog } from "./catalog.js"
import { startMcpHttpServer } from "./mcp/server.js"
import { DocumentStore } from "./storage/database.js"
import { SurfaceService } from "./surface/service.js"
import { runSurface } from "./tui/surface.js"

class UsageError extends Error {}

function usage(): string {
  return `agenteditor — a singleton collaborative Document Surface

Usage:
  agenteditor

Agent control is available only through MCP at http://127.0.0.1:7332/mcp.`
}

async function run(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    throw new UsageError("agenteditor does not accept paths or control commands; use its MCP server")
  }

  const catalog = await loadModelCatalog()
  const service = new SurfaceService({ store: new DocumentStore(), catalog })
  let mcp: ReturnType<typeof startMcpHttpServer> | null = null
  try {
    mcp = startMcpHttpServer(service)
    await runSurface(service)
    return 0
  } finally {
    await mcp?.stop()
    service.close()
  }
}

try {
  process.exitCode = await run()
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`agenteditor: ${error.message}\n\n${usage()}\n`)
    process.exitCode = 2
  } else {
    process.stderr.write("agenteditor: unable to start the Surface\n")
    process.exitCode = 1
  }
}
