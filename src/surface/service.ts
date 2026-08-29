import { DomainError } from "../errors.js"
import { deriveSingleEdit, transformOffset, type TextEdit } from "../document/edits.js"
import { DocumentModel, type Transaction, type TransactionResult } from "../document/model.js"
import { editsFromOperations, type ExactTextOperation } from "../document/operations.js"
import {
  configurationValid,
  defaultConfiguration,
  type Configuration,
  type ModelCatalog,
} from "../catalog.js"
import {
  DocumentStore,
  EMPTY_VIEW_STATE,
  SURFACE_MODES,
  type DocumentSummary,
  type StoredDocument,
  type SurfaceMode,
  type ViewState,
} from "../storage/database.js"

export type PublicTransaction = {
  id: string
  actor: Transaction["actor"]
  at: string
  base_revision: string
  from_revision: string
  to_revision: string
  rebased: boolean
  reverts: string | null
  edits: Array<{ start: number; end: number; inserted: number; removed: number }>
}

export type PublicDocument = {
  document_id: string
  title: string
  revision: string
  model: string | null
  effort: string | null
  configuration_valid: boolean
  created_at: string
  updated_at: string
}

export type SurfaceSnapshot = {
  mode: SurfaceMode
  focused_document: (PublicDocument & { content: string }) | null
  catalog: {
    available: boolean
    error: string | null
  }
}

export type SurfaceEvent =
  | { kind: "documents_changed"; documentId: string }
  | { kind: "document_changed"; documentId: string; transaction: Transaction }
  | { kind: "configuration_changed"; documentId: string }
  | { kind: "focus_changed"; documentId: string }
  | { kind: "mode_changed" }
  | { kind: "save_error"; error: Error | null }

type FocusedRuntime = {
  stored: StoredDocument
  model: DocumentModel
  view: ViewState
}

export class SurfaceService {
  readonly catalog: ModelCatalog
  private readonly store: DocumentStore
  private runtime: FocusedRuntime | null = null
  private mode: SurfaceMode
  private dirtyContent = false
  private dirtyView = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveError: Error | null = null
  private readonly listeners = new Set<(event: SurfaceEvent) => void>()

  constructor(options: { store: DocumentStore; catalog: ModelCatalog }) {
    this.store = options.store
    this.catalog = options.catalog
    const surface = this.store.getSurface()
    this.mode = surface.mode
    if (surface.focusedDocumentId !== null) {
      try {
        this.runtime = this.loadRuntime(surface.focusedDocumentId)
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "document_not_found")) throw error
        this.mode = "standby"
        this.store.setSurface({ focusedDocumentId: null, mode: "standby" })
      }
    }
  }

  subscribe(listener: (event: SurfaceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    try {
      this.flush()
    } finally {
      this.store.close()
    }
  }

  createDocument(input: { title: string; content?: string; focus?: boolean }): PublicDocument {
    const title = input.title.trim()
    if (title.length === 0) throw new DomainError("bad_request", "Document title must not be empty")
    if (title.length > 200) throw new DomainError("bad_request", "Document title must be at most 200 characters")
    const stored = this.store.createDocument({
      title,
      content: input.content ?? "",
      configuration: defaultConfiguration(this.catalog),
    })
    this.emit({ kind: "documents_changed", documentId: stored.id })
    if (input.focus ?? true) this.focusDocument(stored.id)
    return this.publicDocument(stored)
  }

  listDocuments(): PublicDocument[] {
    this.flush()
    return this.store.listDocuments().map((document) => this.publicSummary(document))
  }

  focusDocument(documentId: string): SurfaceSnapshot {
    if (this.runtime?.stored.id === documentId) {
      if (this.mode === "standby") {
        this.mode = "document"
        this.persistSurface()
        this.emit({ kind: "mode_changed" })
      }
      return this.getSurfaceState(false)
    }

    this.flush()
    this.runtime = this.loadRuntime(documentId)
    if (this.mode === "standby") this.mode = "document"
    this.persistSurface()
    this.emit({ kind: "focus_changed", documentId })
    return this.getSurfaceState(false)
  }

  readDocument(input: {
    documentId?: string
    lines?: { start: number; end: number }
  }): Record<string, unknown> {
    const document = this.resolveDocument(input.documentId)
    const base = {
      document_id: document.stored.id,
      title: document.stored.title,
      revision: document.model.revision,
      model: document.stored.configuration.model,
      effort: document.stored.configuration.effort,
      configuration_valid: configurationValid(this.catalog, document.stored.configuration),
    }
    if (!input.lines) return { ...base, content: document.model.text }

    const all = document.model.text.split("\n")
    if (all.at(-1) === "") all.pop()
    if (all.length === 0) return { ...base, range: { start: 0, end: 0, total: 0 }, content: "" }
    const start = Math.max(1, input.lines.start)
    if (start > all.length) {
      return { ...base, range: { start: 0, end: 0, total: all.length }, content: "" }
    }
    const end = Math.min(all.length, Math.max(start, input.lines.end))
    return {
      ...base,
      range: { start, end, total: all.length },
      content: all.slice(start - 1, end).join("\n"),
    }
  }

  editDocument(input: {
    documentId?: string
    baseRevision: string
    operations: ExactTextOperation[]
  }): Record<string, unknown> {
    const runtime = this.resolveDocument(input.documentId)
    if (runtime === this.runtime) this.flush()
    const baseText = runtime.model.snapshot(input.baseRevision)
    const edits = editsFromOperations(baseText, input.operations)
    return this.commit(runtime, input.baseRevision, edits)
  }

  replaceDocument(input: {
    documentId?: string
    baseRevision: string
    content: string
  }): Record<string, unknown> {
    const runtime = this.resolveDocument(input.documentId)
    if (runtime === this.runtime) this.flush()
    if (input.baseRevision !== runtime.model.revision) {
      throw new DomainError("stale_revision", "complete replacement requires the current Revision", {
        recovery: "read the Document again before replacing all of it",
        details: { current_revision: runtime.model.revision },
      })
    }
    const edit = deriveSingleEdit(runtime.model.text, input.content)
    if (!edit) return this.publicMutation(runtime, { changed: false, revision: runtime.model.revision, transaction: null, text: runtime.model.text })
    return this.commit(runtime, input.baseRevision, [edit])
  }

  setSurfaceMode(mode: SurfaceMode): SurfaceSnapshot {
    if (!SURFACE_MODES.includes(mode)) throw new DomainError("bad_request", "unknown Surface mode")
    if (mode !== "standby" && this.runtime === null) {
      throw new DomainError("no_focused_document", "this Surface mode requires a focused Document", {
        recovery: "create or focus a Document first",
      })
    }
    if (this.mode === mode) return this.getSurfaceState(false)
    this.mode = mode
    this.persistSurface()
    this.emit({ kind: "mode_changed" })
    return this.getSurfaceState(false)
  }

  toggleConfiguration(): SurfaceSnapshot {
    if (this.runtime === null) return this.getSurfaceState(false)
    const next: SurfaceMode =
      this.mode === "document_configuration" || this.mode === "configuration"
        ? "document"
        : "document_configuration"
    return this.setSurfaceMode(next)
  }

  setConfiguration(input: {
    documentId?: string
    model: string
    effort: string
  }): PublicDocument {
    if (this.catalog.models.length === 0) {
      throw new DomainError("catalog_unavailable", "the model Catalog was unavailable at Surface startup", {
        recovery: "restart the Surface after Codex model discovery is available",
      })
    }
    const catalogModel = this.catalog.models.find((candidate) => candidate.id === input.model)
    if (!catalogModel) {
      throw new DomainError("invalid_configuration", "the selected model is not in the startup Catalog", {
        recovery: "call list_models and choose one of the returned model IDs",
      })
    }
    if (!catalogModel.efforts.includes(input.effort)) {
      throw new DomainError("invalid_configuration", "the selected effort is not supported by that model", {
        recovery: "call list_models and choose an effort listed for the selected model",
        details: { model: input.model, supported_efforts: catalogModel.efforts },
      })
    }

    const runtime = this.resolveDocument(input.documentId)
    const stored = this.store.setConfiguration(runtime.stored.id, {
      model: input.model,
      effort: input.effort,
    })
    runtime.stored = stored
    this.emit({ kind: "configuration_changed", documentId: stored.id })
    return this.publicDocument(stored)
  }

  getSurfaceState(flush = true): SurfaceSnapshot {
    if (flush) this.flush()
    return {
      mode: this.mode,
      focused_document:
        this.runtime === null
          ? null
          : {
              ...this.publicDocument(this.runtime.stored, this.runtime.model.revision),
              content: this.runtime.model.text,
            },
      catalog: {
        available: this.catalog.models.length > 0,
        error: this.catalog.error,
      },
    }
  }

  getFocusedView(): ViewState | null {
    return this.runtime ? { ...this.runtime.view } : null
  }

  setFocusedView(view: ViewState): void {
    if (this.runtime === null) return
    const length = this.runtime.model.text.length
    const cursor = clampInteger(view.cursor, 0, length)
    const validSelection =
      view.selectionStart !== null &&
      view.selectionEnd !== null &&
      view.selectionStart >= 0 &&
      view.selectionEnd >= view.selectionStart &&
      view.selectionEnd <= length
    const next = {
      cursor,
      selectionStart: validSelection ? view.selectionStart : null,
      selectionEnd: validSelection ? view.selectionEnd : null,
      viewportX: Math.max(0, Math.trunc(view.viewportX)),
      viewportY: Math.max(0, Math.trunc(view.viewportY)),
    }
    if (viewStatesEqual(this.runtime.view, next)) return
    this.runtime.view = next
    this.dirtyView = true
    this.scheduleSave()
  }

  applyHumanText(text: string, cursorRegion?: { start: number; end: number }): TransactionResult {
    const runtime = this.requireFocused()
    const edit = deriveSingleEdit(runtime.model.text, text)
    if (!edit) return { changed: false, revision: runtime.model.revision, transaction: null, text: runtime.model.text }
    const result = runtime.model.apply({
      actor: "human",
      baseRevision: runtime.model.revision,
      edits: [edit],
      ignoreActiveRegion: true,
    })
    if (cursorRegion) runtime.model.setActiveRegion(cursorRegion.start, cursorRegion.end)
    this.dirtyContent = true
    this.scheduleSave()
    if (result.transaction) {
      this.emit({ kind: "document_changed", documentId: runtime.stored.id, transaction: result.transaction })
    }
    return result
  }

  setActiveRegion(start: number, end: number): void {
    this.runtime?.model.setActiveRegion(start, end)
  }

  undoHuman(transactionId: string): TransactionResult {
    const runtime = this.requireFocused()
    this.flush()
    const candidate = runtime.model.fork()
    const result = candidate.undo(transactionId, "human", candidate.revision)
    const stored = this.store.saveRuntime(runtime.stored.id, candidate, runtime.view, result.changed)
    runtime.model = candidate
    runtime.stored = stored
    this.clearSaveError()
    if (result.transaction) {
      this.emit({ kind: "document_changed", documentId: stored.id, transaction: result.transaction })
    }
    return result
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.runtime === null || (!this.dirtyContent && !this.dirtyView)) return
    try {
      this.runtime.stored = this.store.saveRuntime(
        this.runtime.stored.id,
        this.runtime.model,
        this.runtime.view,
        this.dirtyContent,
      )
      this.dirtyContent = false
      this.dirtyView = false
      this.clearSaveError()
    } catch (error) {
      this.setSaveError(error)
      throw error
    }
  }

  private commit(runtime: FocusedRuntime, baseRevision: string, edits: TextEdit[]): Record<string, unknown> {
    const candidate = runtime.model.fork()
    const result = candidate.apply({ actor: "assistant", baseRevision, edits })
    if (!result.changed) return this.publicMutation(runtime, result)
    const view = transformView(runtime.view, result.transaction!.edits, candidate.text.length)
    const stored = this.store.saveRuntime(runtime.stored.id, candidate, view, true)
    runtime.model = candidate
    runtime.stored = stored
    runtime.view = view
    if (runtime === this.runtime) {
      this.dirtyContent = false
      this.dirtyView = false
    }
    this.clearSaveError()
    if (result.transaction) {
      this.emit({ kind: "document_changed", documentId: stored.id, transaction: result.transaction })
    }
    return this.publicMutation(runtime, result)
  }

  private resolveDocument(documentId?: string): FocusedRuntime {
    if (documentId === undefined) return this.requireFocused()
    if (this.runtime?.stored.id === documentId) return this.runtime
    return this.loadRuntime(documentId)
  }

  private requireFocused(): FocusedRuntime {
    if (this.runtime === null) {
      throw new DomainError("no_focused_document", "the Surface has no focused Document", {
        recovery: "create or focus a Document first",
      })
    }
    return this.runtime
  }

  private loadRuntime(documentId: string): FocusedRuntime {
    const stored = this.store.getDocument(documentId)
    return {
      stored,
      model: DocumentModel.restore(stored.content, stored.serialized),
      view: { ...stored.view },
    }
  }

  private publicDocument(stored: StoredDocument, revision = stored.revision): PublicDocument {
    return {
      document_id: stored.id,
      title: stored.title,
      revision,
      model: stored.configuration.model,
      effort: stored.configuration.effort,
      configuration_valid: configurationValid(this.catalog, stored.configuration),
      created_at: stored.createdAt,
      updated_at: stored.updatedAt,
    }
  }

  private publicSummary(summary: DocumentSummary): PublicDocument {
    return {
      document_id: summary.id,
      title: summary.title,
      revision: summary.revision,
      model: summary.configuration.model,
      effort: summary.configuration.effort,
      configuration_valid: configurationValid(this.catalog, summary.configuration),
      created_at: summary.createdAt,
      updated_at: summary.updatedAt,
    }
  }

  private publicMutation(runtime: FocusedRuntime, result: TransactionResult): Record<string, unknown> {
    return {
      document_id: runtime.stored.id,
      changed: result.changed,
      revision: result.revision,
      transaction: publicTransaction(result.transaction),
    }
  }

  private persistSurface(): void {
    this.store.setSurface({ focusedDocumentId: this.runtime?.stored.id ?? null, mode: this.mode })
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        this.flush()
      } catch {}
    }, 120)
  }

  private setSaveError(error: unknown): void {
    this.saveError = error instanceof Error ? error : new Error(String(error))
    this.emit({ kind: "save_error", error: this.saveError })
  }

  private clearSaveError(): void {
    if (this.saveError === null) return
    this.saveError = null
    this.emit({ kind: "save_error", error: null })
  }

  private emit(event: SurfaceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function publicTransaction(transaction: Transaction | null): PublicTransaction | null {
  if (!transaction) return null
  return {
    id: transaction.id,
    actor: transaction.actor,
    at: transaction.at,
    base_revision: transaction.baseRevision,
    from_revision: transaction.fromRevision,
    to_revision: transaction.toRevision,
    rebased: transaction.rebased,
    reverts: transaction.reverts,
    edits: transaction.edits.map((edit) => ({
      start: edit.start,
      end: edit.end,
      inserted: edit.text.length,
      removed: edit.end - edit.start,
    })),
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

function transformView(view: ViewState, edits: readonly TextEdit[], length: number): ViewState {
  return {
    cursor: Math.min(transformOffset(view.cursor, edits), length),
    selectionStart:
      view.selectionStart === null ? null : Math.min(transformOffset(view.selectionStart, edits, "before"), length),
    selectionEnd:
      view.selectionEnd === null ? null : Math.min(transformOffset(view.selectionEnd, edits, "after"), length),
    viewportX: view.viewportX,
    viewportY: view.viewportY,
  }
}

function viewStatesEqual(left: ViewState, right: ViewState): boolean {
  return (
    left.cursor === right.cursor &&
    left.selectionStart === right.selectionStart &&
    left.selectionEnd === right.selectionEnd &&
    left.viewportX === right.viewportX &&
    left.viewportY === right.viewportY
  )
}
