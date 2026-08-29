import { loadModelCatalog } from "./catalog.js"
import { startMcpHttpServer } from "./mcp/server.js"
import { DocumentStore } from "./storage/database.js"
import { SurfaceService } from "./surface/service.js"
import { runSurface } from "./tui/surface.js"

export async function runEditor(): Promise<number> {
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
