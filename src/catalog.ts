export type CatalogModel = {
  id: string
  defaultEffort: string | null
  efforts: string[]
}

export type ModelCatalog = {
  source: string
  loadedAt: string
  models: CatalogModel[]
  error: string | null
}

export type Configuration = {
  model: string | null
  effort: string | null
}

type JsonObject = Record<string, unknown>

class JsonlClient {
  private readonly reader
  private readonly decoder = new TextDecoder()
  private buffer = ""

  constructor(private readonly process: Bun.Subprocess<"pipe", "pipe", "ignore">) {
    this.reader = process.stdout.getReader()
  }

  send(message: JsonObject): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
    this.process.stdin.flush()
  }

  async receiveResponse(requestId: number): Promise<JsonObject> {
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.length === 0) continue
        const message = JSON.parse(line) as JsonObject
        if (message.id !== requestId) continue
        if (message.error !== undefined) throw new Error("Codex model discovery returned an error")
        const result = message.result
        if (result === null || typeof result !== "object" || Array.isArray(result)) {
          throw new Error("Codex model discovery returned invalid data")
        }
        return result as JsonObject
      }

      const chunk = await this.reader.read()
      if (chunk.done) throw new Error("Codex model discovery ended before responding")
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
    }
  }
}

export async function loadModelCatalog(options: {
  command?: string[]
  timeoutMs?: number
} = {}): Promise<ModelCatalog> {
  const loadedAt = new Date().toISOString()
  const command = options.command ?? ["codex", "app-server", "--stdio"]
  let process: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    process = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    const spawned = process
    timeout = setTimeout(() => spawned.kill(), options.timeoutMs ?? 8_000)
    const client = new JsonlClient(spawned)
    client.send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "agenteditor_catalog",
          title: "agenteditor Catalog",
          version: "0.2.0",
        },
      },
    })
    await client.receiveResponse(0)
    client.send({ method: "initialized", params: {} })

    const rawModels: JsonObject[] = []
    let cursor: string | null = null
    let requestId = 1
    do {
      const params: JsonObject = { limit: 100, includeHidden: false }
      if (cursor !== null) params.cursor = cursor
      client.send({ method: "model/list", id: requestId, params })
      const result = await client.receiveResponse(requestId)
      if (!Array.isArray(result.data)) throw new Error("Codex model discovery returned invalid data")
      rawModels.push(...result.data.filter(isJsonObject))
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null
      requestId += 1
    } while (cursor !== null)

    spawned.stdin.end()
    const exitCode = await spawned.exited
    if (exitCode !== 0) throw new Error("Codex model discovery failed")

    const models = rawModels.flatMap((model): CatalogModel[] => {
      if (model.hidden === true || typeof model.id !== "string") return []
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
            .filter(isJsonObject)
            .map((entry) => entry.reasoningEffort)
            .filter((effort): effort is string => typeof effort === "string")
        : []
      const defaultEffort =
        typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : efforts[0] ?? null
      if (defaultEffort !== null && !efforts.includes(defaultEffort)) efforts.unshift(defaultEffort)
      if (efforts.length === 0) return []
      return [{ id: model.id, defaultEffort, efforts: [...new Set(efforts)] }]
    })

    return {
      source: "codex app-server model/list",
      loadedAt,
      models,
      error: models.length === 0 ? "No configurable models were available at Surface startup" : null,
    }
  } catch {
    process?.kill()
    return {
      source: "codex app-server model/list",
      loadedAt,
      models: [],
      error: "The model Catalog was unavailable at Surface startup",
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    process?.stdin.end()
  }
}

export function defaultConfiguration(catalog: ModelCatalog): Configuration {
  const model = catalog.models[0]
  if (!model) return { model: null, effort: null }
  return {
    model: model.id,
    effort: model.defaultEffort ?? model.efforts[0] ?? null,
  }
}

export function configurationValid(catalog: ModelCatalog, configuration: Configuration): boolean {
  if (configuration.model === null || configuration.effort === null) return false
  const model = catalog.models.find((candidate) => candidate.id === configuration.model)
  return model?.efforts.includes(configuration.effort) ?? false
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
