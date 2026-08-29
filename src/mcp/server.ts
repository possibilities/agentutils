import {
  McpServer,
  ResourceTemplate,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server"
import { z } from "zod"
import { asDomainError } from "../errors.js"
import { SURFACE_MODES, type SurfaceMode } from "../storage/database.js"
import type { SurfaceEvent, SurfaceService } from "../surface/service.js"

export const DEFAULT_MCP_HOST = "127.0.0.1"
export const DEFAULT_MCP_PORT = 7332
export const MCP_PATH = "/mcp"
export const EDITOR_RESOURCE_BASE = "agentutils://editor"

const SURFACE_RESOURCE_URI = `${EDITOR_RESOURCE_BASE}/surface`
const DOCUMENTS_RESOURCE_URI = `${EDITOR_RESOURCE_BASE}/documents`
const MODELS_RESOURCE_URI = `${EDITOR_RESOURCE_BASE}/models`

const DocumentIdSchema = z
  .string()
  .regex(/^doc_[0-9a-f]{32}$/u, "must be an opaque AgentUtils Editor Document ID")
const RevisionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "must be an AgentUtils Editor Revision")
const TransactionIdSchema = z.string().regex(/^tx_[0-9a-f]{32}$/u)

const PublicDocumentSchema = z
  .object({
    document_id: DocumentIdSchema,
    title: z.string(),
    revision: RevisionSchema,
    model: z.string().nullable(),
    effort: z.string().nullable(),
    configuration_valid: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict()

const FocusedDocumentSchema = PublicDocumentSchema.extend({ content: z.string() }).strict()
const SurfaceSnapshotSchema = z
  .object({
    mode: z.enum(SURFACE_MODES),
    focused_document: FocusedDocumentSchema.nullable(),
    catalog: z.object({ available: z.boolean(), error: z.string().nullable() }).strict(),
  })
  .strict()

const MutationSchema = z
  .object({
    document_id: DocumentIdSchema,
    changed: z.boolean(),
    revision: RevisionSchema,
    transaction: z
      .object({
        id: TransactionIdSchema,
        actor: z.enum(["assistant", "human"]),
        at: z.string(),
        base_revision: RevisionSchema,
        from_revision: RevisionSchema,
        to_revision: RevisionSchema,
        rebased: z.boolean(),
        reverts: TransactionIdSchema.nullable(),
        edits: z.array(
          z
            .object({
              start: z.number().int().nonnegative(),
              end: z.number().int().nonnegative(),
              inserted: z.number().int().nonnegative(),
              removed: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
  })
  .strict()

const LineRangeSchema = z
  .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
  .strict()
  .refine((range) => range.end >= range.start, { message: "end must be at or after start" })

const ReadDocumentOutputSchema = z
  .object({
    document_id: DocumentIdSchema,
    title: z.string(),
    revision: RevisionSchema,
    model: z.string().nullable(),
    effort: z.string().nullable(),
    configuration_valid: z.boolean(),
    range: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    content: z.string(),
  })
  .strict()

const CatalogOutputSchema = z
  .object({
    source: z.string(),
    loaded_at: z.string(),
    available: z.boolean(),
    error: z.string().nullable(),
    models: z.array(
      z
        .object({
          id: z.string(),
          default_effort: z.string().nullable(),
          efforts: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict()

const ExactOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert_before"), target: z.string().min(1), text: z.string() }).strict(),
  z.object({ kind: z.literal("insert_after"), target: z.string().min(1), text: z.string() }).strict(),
  z.object({ kind: z.literal("replace"), target: z.string().min(1), text: z.string() }).strict(),
  z.object({ kind: z.literal("delete"), target: z.string().min(1) }).strict(),
])

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const LOCAL_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

const CONTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

export function createEditorMcpHandler(service: SurfaceService): {
  handler: McpHttpHandler
  close: () => Promise<void>
} {
  const handler = createMcpHandler((context) => buildServer(service, context.era === "modern"), {
    legacy: "stateless",
    responseMode: "auto",
    onerror: () => {},
  })
  const unsubscribe = service.subscribe((event) => notify(handler, service, event))
  return {
    handler,
    close: async () => {
      unsubscribe()
      await handler.close()
    },
  }
}

export function startMcpHttpServer(
  service: SurfaceService,
  options: { port?: number } = {},
): {
  url: string
  port: number
  stop: () => Promise<void>
} {
  const configuredPort = options.port ?? DEFAULT_MCP_PORT
  const mcp = createEditorMcpHandler(service)
  const server = Bun.serve({
    hostname: DEFAULT_MCP_HOST,
    port: configuredPort,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== MCP_PATH) return new Response("Not found", { status: 404 })
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins())
      return rejected ?? mcp.handler.fetch(request)
    },
  })
  const actualPort = server.port ?? configuredPort

  return {
    url: `http://${DEFAULT_MCP_HOST}:${actualPort}${MCP_PATH}`,
    port: actualPort,
    stop: async () => {
      await mcp.close()
      await Promise.resolve(server.stop(true))
    },
  }
}

function buildServer(service: SurfaceService, modern: boolean): McpServer {
  const server = new McpServer(
    { name: "agentutils-editor", version: "0.3.0" },
    {
      ...(modern
        ? { capabilities: { resources: { listChanged: true, subscribe: true } } }
        : {}),
      instructions:
        "AgentUtils Editor is one shared Document Surface. Create or focus a Document before editing. Every content mutation requires the Revision returned by a read; on conflict, reread and retry without forcing. Model and effort are inert per-Document Configuration. Immediately before an external launch, call get_surface_state for one atomic content/configuration snapshot. AgentUtils Editor never launches or submits anything.",
    },
  )

  registerResources(server, service)
  registerTools(server, service)
  return server
}

function registerResources(server: McpServer, service: SurfaceService): void {
  server.registerResource(
    "surface",
    SURFACE_RESOURCE_URI,
    {
      title: "AgentUtils Editor Surface",
      description: "Focused Document, Surface mode, Configuration, and Catalog status",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    (uri) => jsonResource(uri, service.getSurfaceState(false)),
  )

  server.registerResource(
    "documents",
    DOCUMENTS_RESOURCE_URI,
    {
      title: "AgentUtils Editor Documents",
      description: "All resumable Documents, newest first",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    (uri) => jsonResource(uri, { documents: service.listDocuments() }),
  )

  server.registerResource(
    "models",
    MODELS_RESOURCE_URI,
    {
      title: "AgentUtils Editor model Catalog",
      description: "Models and reasoning efforts loaded at Surface startup",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    (uri) => jsonResource(uri, catalogData(service)),
  )

  server.registerResource(
    "document",
    new ResourceTemplate(`${DOCUMENTS_RESOURCE_URI}/{document_id}`, {
      list: () => ({
        resources: service.listDocuments().map((document) => ({
          uri: documentUri(document.document_id),
          name: document.document_id,
          title: document.title,
          description: `Document at Revision ${document.revision}`,
          mimeType: "application/json",
        })),
      }),
      complete: {
        document_id: (value) =>
          service
            .listDocuments()
            .map((document) => document.document_id)
            .filter((id) => id.startsWith(value)),
      },
    }),
    {
      title: "AgentUtils Editor Document",
      description: "Document content, Revision, and Configuration",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    (uri, variables) =>
      jsonResource(
        uri,
        service.readDocument({ documentId: variableString(variables.document_id) }),
      ),
  )
}

function registerTools(server: McpServer, service: SurfaceService): void {
  server.registerTool(
    "create_document",
    {
      title: "Create Document",
      description: "Create an opaque private Document and optionally focus it",
      inputSchema: z
        .object({
          title: z.string().min(1).max(200),
          content: z.string().optional(),
          focus: z.boolean().default(true),
        })
        .strict(),
      outputSchema: PublicDocumentSchema,
      annotations: LOCAL_WRITE,
    },
    ({ title, content, focus }) =>
      toolCall(() =>
        service.createDocument({
          title,
          focus,
          ...(content === undefined ? {} : { content }),
        }),
      ),
  )

  server.registerTool(
    "list_documents",
    {
      title: "List Documents",
      description: "List resumable Documents without filesystem paths",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ documents: z.array(PublicDocumentSchema) }).strict(),
      annotations: READ_ONLY,
    },
    () => toolCall(() => ({ documents: service.listDocuments() })),
  )

  server.registerTool(
    "focus_document",
    {
      title: "Focus Document",
      description: "Focus a Document on the singleton Surface and restore its human view state",
      inputSchema: z.object({ document_id: DocumentIdSchema }).strict(),
      outputSchema: SurfaceSnapshotSchema,
      annotations: LOCAL_WRITE,
    },
    ({ document_id }) => toolCall(() => service.focusDocument(document_id)),
  )

  server.registerTool(
    "read_document",
    {
      title: "Read Document",
      description: "Read a complete Document or a one-based inclusive line range",
      inputSchema: z
        .object({
          document_id: DocumentIdSchema.optional(),
          lines: LineRangeSchema.optional(),
        })
        .strict(),
      outputSchema: ReadDocumentOutputSchema,
      annotations: READ_ONLY,
    },
    ({ document_id, lines }) =>
      toolCall(() =>
        service.readDocument({
          ...(document_id === undefined ? {} : { documentId: document_id }),
          ...(lines === undefined ? {} : { lines }),
        }),
      ),
  )

  server.registerTool(
    "edit_document",
    {
      title: "Edit Document",
      description: "Apply atomic exact-text operations guarded by a base Revision",
      inputSchema: z
        .object({
          document_id: DocumentIdSchema.optional(),
          base_revision: RevisionSchema,
          edits: z.array(ExactOperationSchema).min(1),
        })
        .strict(),
      outputSchema: MutationSchema,
      annotations: CONTENT_WRITE,
    },
    ({ document_id, base_revision, edits }) =>
      toolCall(() =>
        service.editDocument({
          ...(document_id === undefined ? {} : { documentId: document_id }),
          baseRevision: base_revision,
          operations: edits,
        }),
      ),
  )

  server.registerTool(
    "replace_document",
    {
      title: "Replace Document",
      description: "Replace a complete Document at its current Revision",
      inputSchema: z
        .object({
          document_id: DocumentIdSchema.optional(),
          base_revision: RevisionSchema,
          content: z.string(),
        })
        .strict(),
      outputSchema: MutationSchema,
      annotations: CONTENT_WRITE,
    },
    ({ document_id, base_revision, content }) =>
      toolCall(() =>
        service.replaceDocument({
          ...(document_id === undefined ? {} : { documentId: document_id }),
          baseRevision: base_revision,
          content,
        }),
      ),
  )

  server.registerTool(
    "set_surface_mode",
    {
      title: "Set Surface Mode",
      description: "Control Document and Configuration visibility on the singleton Surface",
      inputSchema: z.object({ mode: z.enum(SURFACE_MODES) }).strict(),
      outputSchema: SurfaceSnapshotSchema,
      annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    ({ mode }) => toolCall(() => service.setSurfaceMode(mode as SurfaceMode)),
  )

  server.registerTool(
    "list_models",
    {
      title: "List Models",
      description: "Read the immutable model and effort Catalog loaded at Surface startup",
      inputSchema: z.object({}).strict(),
      outputSchema: CatalogOutputSchema,
      annotations: READ_ONLY,
    },
    () => toolCall(() => catalogData(service)),
  )

  server.registerTool(
    "set_configuration",
    {
      title: "Set Configuration",
      description: "Store a valid model and reasoning effort on a Document without launching anything",
      inputSchema: z
        .object({
          document_id: DocumentIdSchema.optional(),
          model: z.string().min(1),
          effort: z.string().min(1),
        })
        .strict(),
      outputSchema: PublicDocumentSchema,
      annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    ({ document_id, model, effort }) =>
      toolCall(() =>
        service.setConfiguration({
          ...(document_id === undefined ? {} : { documentId: document_id }),
          model,
          effort,
        }),
      ),
  )

  server.registerTool(
    "get_surface_state",
    {
      title: "Get Surface State",
      description: "Atomically read focused content, Revision, model, and effort for an external handoff",
      inputSchema: z.object({}).strict(),
      outputSchema: SurfaceSnapshotSchema,
      annotations: READ_ONLY,
    },
    () => toolCall(() => service.getSurfaceState()),
  )
}

function toolCall(operation: () => Record<string, unknown>): CallToolResult {
  try {
    const data = operation()
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    }
  } catch (error) {
    const domain = asDomainError(error)
    const body = {
      error: {
        code: domain.code,
        message: domain.message,
        ...(domain.recovery === undefined ? {} : { recovery: domain.recovery }),
        ...(domain.details === undefined ? {} : { details: domain.details }),
      },
    }
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      isError: true,
    }
  }
}

function catalogData(service: SurfaceService): Record<string, unknown> {
  return {
    source: service.catalog.source,
    loaded_at: service.catalog.loadedAt,
    available: service.catalog.models.length > 0,
    error: service.catalog.error,
    models: service.catalog.models.map((model) => ({
      id: model.id,
      default_effort: model.defaultEffort,
      efforts: model.efforts,
    })),
  }
}

function jsonResource(uri: URL, data: unknown): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data),
      },
    ],
  }
}

function notify(handler: McpHttpHandler, service: SurfaceService, event: SurfaceEvent): void {
  switch (event.kind) {
    case "documents_changed":
      handler.notify.resourcesChanged()
      handler.notify.resourceUpdated(DOCUMENTS_RESOURCE_URI)
      handler.notify.resourceUpdated(documentUri(event.documentId))
      break
    case "document_changed":
    case "configuration_changed":
      handler.notify.resourceUpdated(documentUri(event.documentId))
      handler.notify.resourceUpdated(DOCUMENTS_RESOURCE_URI)
      handler.notify.resourceUpdated(SURFACE_RESOURCE_URI)
      break
    case "focus_changed":
    case "mode_changed":
      handler.notify.resourceUpdated(SURFACE_RESOURCE_URI)
      break
    case "save_error":
      if (event.error === null) handler.notify.resourceUpdated(SURFACE_RESOURCE_URI)
      break
  }

  if (event.kind === "focus_changed") {
    const focused = service.getSurfaceState(false).focused_document
    if (focused) handler.notify.resourceUpdated(documentUri(focused.document_id))
  }
}

function documentUri(documentId: string): string {
  return `${DOCUMENTS_RESOURCE_URI}/${encodeURIComponent(documentId)}`
}

function variableString(value: string | string[] | undefined): string {
  if (value === undefined) return ""
  return Array.isArray(value) ? value[0] ?? "" : value
}
