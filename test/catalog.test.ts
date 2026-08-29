import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadModelCatalog } from "../src/catalog.js"

const fakeServer = join(import.meta.dir, "fixtures", "catalog-app-server.ts")

describe("startup Catalog", () => {
  test("loads and normalizes every visible model page once", async () => {
    const catalog = await loadModelCatalog({ command: [process.execPath, fakeServer] })
    expect(catalog).toMatchObject({
      source: "codex app-server model/list",
      error: null,
      models: [
        { id: "gpt-primary", defaultEffort: "medium", efforts: ["low", "medium"] },
        { id: "gpt-fast", defaultEffort: "low", efforts: ["low"] },
      ],
    })
  })

  test("degrades to an inert unavailable Catalog without leaking process errors", async () => {
    const catalog = await loadModelCatalog({
      command: [process.execPath, "-e", "process.stderr.write('/private/catalog-secret'); process.exit(7)"],
      timeoutMs: 100,
    })
    expect(catalog.models).toEqual([])
    expect(catalog.error).toBe("The model Catalog was unavailable at Surface startup")
    expect(JSON.stringify(catalog)).not.toContain("catalog-secret")
  })
})
