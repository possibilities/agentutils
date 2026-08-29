import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { ModelCatalog } from "../src/catalog.js"
import { startMcpHttpServer } from "../src/mcp/server.js"
import { DocumentStore } from "../src/storage/database.js"
import { SurfaceService } from "../src/surface/service.js"
import { makeTempDir, removeTempDirs } from "./helpers.js"

afterEach(removeTempDirs)

const catalog: ModelCatalog = {
  source: "test Catalog",
  loadedAt: "2026-08-29T00:00:00.000Z",
  error: null,
  models: [
    { id: "gpt-test", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
    { id: "gpt-fast", defaultEffort: "low", efforts: ["low"] },
  ],
}

describe("MCP Surface", () => {
  test("exposes the agent workflow through the official Streamable HTTP client", async () => {
    const databasePath = join(makeTempDir("agentutils-mcp-"), "private.sqlite3")
    const service = new SurfaceService({ store: new DocumentStore(databasePath), catalog })
    const http = startMcpHttpServer(service, { port: 0 })
    const client = new Client(
      { name: "agentutils-editor-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    )
    const surfaceUpdated = Promise.withResolvers<string>()
    const resourcesChanged = Promise.withResolvers<boolean>()
    let subscription: { close: () => Promise<void> } | null = null

    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      surfaceUpdated.resolve(notification.params.uri)
    })
    client.setNotificationHandler("notifications/resources/list_changed", () => {
      resourcesChanged.resolve(true)
    })

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url)))
      expect(client.getServerVersion()).toMatchObject({
        name: "agentutils-editor",
        version: "0.3.0",
      })
      subscription = await client.listen({
        resourcesListChanged: true,
        resourceSubscriptions: ["agentutils://editor/surface"],
      })
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        [
          "create_document",
          "edit_document",
          "focus_document",
          "get_surface_state",
          "list_documents",
          "list_models",
          "read_document",
          "replace_document",
          "set_configuration",
          "set_surface_mode",
        ].sort(),
      )

      const createResult = await client.callTool({
        name: "create_document",
        arguments: { title: "Release prompt", content: "Draft the release notes." },
      })
      expect(createResult.isError).not.toBe(true)
      const created = record(createResult.structuredContent)
      expect(created.document_id).toMatch(/^doc_[0-9a-f]{32}$/)
      expect(created).not.toHaveProperty("path")
      expect(await withTimeout(resourcesChanged.promise, "resource list change")).toBe(true)
      expect(await withTimeout(surfaceUpdated.promise, "Surface update")).toBe(
        "agentutils://editor/surface",
      )

      const editResult = await client.callTool({
        name: "edit_document",
        arguments: {
          document_id: created.document_id,
          base_revision: created.revision,
          edits: [
            {
              kind: "insert_after",
              target: "Draft the release notes.",
              text: "\n\nInclude user-visible changes only.",
            },
          ],
        },
      })
      expect(editResult.isError).not.toBe(true)
      expect(record(editResult.structuredContent).transaction).toMatchObject({
        base_revision: created.revision,
      })
      expect(record(record(editResult.structuredContent).transaction)).not.toHaveProperty("baseRevision")

      const configurationResult = await client.callTool({
        name: "set_configuration",
        arguments: { model: "gpt-test", effort: "high" },
      })
      expect(configurationResult.isError).not.toBe(true)
      await client.callTool({
        name: "set_surface_mode",
        arguments: { mode: "document_configuration" },
      })

      const stateResult = await client.callTool({ name: "get_surface_state", arguments: {} })
      const state = record(stateResult.structuredContent)
      expect(state).toMatchObject({
        mode: "document_configuration",
        focused_document: {
          document_id: created.document_id,
          title: "Release prompt",
          content: "Draft the release notes.\n\nInclude user-visible changes only.",
          model: "gpt-test",
          effort: "high",
          configuration_valid: true,
        },
      })
      expect(state).not.toHaveProperty("submission")
      expect(state).not.toHaveProperty("launch")

      const failure = await client.callTool({
        name: "edit_document",
        arguments: {
          base_revision: record(state.focused_document).revision,
          edits: [{ kind: "delete", target: "missing exact text" }],
        },
      })
      expect(failure.isError).toBe(true)
      expect(record(record(failure.structuredContent).error)).toMatchObject({
        code: "edit_target_not_found",
      })

      const opaqueIdFailure = await client.callTool({
        name: "read_document",
        arguments: { document_id: databasePath },
      })
      expect(opaqueIdFailure.isError).toBe(true)
      expect(JSON.stringify(opaqueIdFailure)).not.toContain(databasePath)

      const resources = await client.listResources()
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        `agentutils://editor/documents/${created.document_id}`,
      )
      const documentResource = await client.readResource({
        uri: `agentutils://editor/documents/${created.document_id}`,
      })
      const serialized = JSON.stringify({ created, state, documentResource })
      expect(serialized).not.toContain(databasePath)
      expect(serialized).not.toContain("private.sqlite3")
      expect(serialized).not.toMatch(/"path"\s*:/u)
    } finally {
      await subscription?.close().catch(() => {})
      await client.close().catch(() => {})
      await http.stop()
      service.close()
    }
  })

  test("rejects non-loopback Host and Origin headers before MCP dispatch", async () => {
    const service = new SurfaceService({ store: new DocumentStore(":memory:"), catalog })
    const http = startMcpHttpServer(service, { port: 0 })
    try {
      const badHost = await fetch(http.url, { headers: { host: "example.test" } })
      expect(badHost.status).toBe(403)

      const badOrigin = await fetch(http.url, {
        headers: { origin: "https://example.test" },
      })
      expect(badOrigin.status).toBe(403)
    } finally {
      await http.stop()
      service.close()
    }
  })

  test("keeps tools available when resource subscriptions are absent", async () => {
    const service = new SurfaceService({ store: new DocumentStore(":memory:"), catalog })
    const http = startMcpHttpServer(service, { port: 0 })
    const client = new Client({ name: "agentutils-editor-basic-test", version: "1.0.0" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url)))
      expect((await client.listTools()).tools).toHaveLength(10)
      expect(client.getServerCapabilities()?.resources?.subscribe).not.toBe(true)
    } finally {
      await client.close().catch(() => {})
      await http.stop()
      service.close()
    }
  })
})

function record(value: unknown): Record<string, any> {
  expect(value).toBeObject()
  return value as Record<string, any>
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for MCP ${label}`)), 1_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
