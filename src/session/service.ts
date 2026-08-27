import { DomainError } from "../errors.js"
import { deriveSingleEdit, type TextEdit } from "../document/edits.js"
import { saveJournal } from "../document/journal.js"
import { DocumentModel, type Transaction, type TransactionResult } from "../document/model.js"
import { DocumentPersistence } from "../document/persistence.js"
import { editsFromUnifiedDiff } from "../document/unified-diff.js"

export type PublicTransaction = Omit<Transaction, "edits" | "inverse"> & {
  edits: Array<{ start: number; end: number; inserted: number; removed: number }>
}

export type ServiceRequest =
  | { kind: "read"; lines?: { start: number; end: number } }
  | { kind: "status" }
  | { kind: "history" }
  | { kind: "apply"; baseRevision: string; patch: string; actor: string; message?: string }
  | { kind: "write"; baseRevision?: string; content: string; actor: string; message?: string; create?: boolean }

export class DocumentService {
  private _model: DocumentModel
  private readonly persistence: DocumentPersistence
  private readonly journalPath: string
  private readonly sessionActive: boolean
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveError: Error | null = null
  private readonly listeners = new Set<(transaction: Transaction) => void>()
  private readonly saveErrorListeners = new Set<(error: Error | null) => void>()

  constructor(options: {
    model: DocumentModel
    persistence: DocumentPersistence
    journalPath: string
    sessionActive: boolean
  }) {
    this._model = options.model
    this.persistence = options.persistence
    this.journalPath = options.journalPath
    this.sessionActive = options.sessionActive
  }

  get model(): DocumentModel {
    return this._model
  }

  get path(): string {
    return this.persistence.path
  }

  async request(request: ServiceRequest): Promise<unknown> {
    switch (request.kind) {
      case "read":
        return this.read(request.lines)
      case "status":
        return this.status()
      case "history":
        return { revision: this._model.revision, transactions: this._model.history.map(publicTransaction) }
      case "apply":
        assertAgentActor(request.actor)
        return publicMutation(this.applyPatch(request))
      case "write":
        assertAgentActor(request.actor)
        return publicMutation(this.write(request))
    }
  }

  applyHumanText(text: string, cursorRegion?: { start: number; end: number }): TransactionResult {
    const edit = deriveSingleEdit(this._model.text, text)
    if (!edit) return { changed: false, revision: this._model.revision, transaction: null, text: this._model.text }
    const result = this._model.apply({
      actor: "human",
      baseRevision: this._model.revision,
      edits: [edit],
      ignoreActiveRegion: true,
    })
    if (cursorRegion) this._model.setActiveRegion(cursorRegion.start, cursorRegion.end)
    this.markDirty(result)
    this.scheduleSave()
    return result
  }

  setActiveRegion(start: number, end: number): void {
    this._model.setActiveRegion(start, end)
  }

  undoTransaction(transactionId: string, actor = "human"): TransactionResult {
    return this.undo(transactionId, actor, this._model.revision)
  }

  subscribe(listener: (transaction: Transaction) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSaveError(listener: (error: Error | null) => void): () => void {
    this.saveErrorListeners.add(listener)
    return () => this.saveErrorListeners.delete(listener)
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    this.persistence.save(this._model.text)
    saveJournal(this.journalPath, this._model)
    this.dirty = false
    const hadError = this.saveError !== null
    this.saveError = null
    if (hadError) this.emitSaveError(null)
  }

  close(): void {
    this.flush()
  }

  private read(lines?: { start: number; end: number }): Record<string, unknown> {
    if (!lines) return { document: this.path, revision: this._model.revision, content: this._model.text }
    const all = this._model.text.split("\n")
    if (all.at(-1) === "") all.pop()
    if (all.length === 0) {
      return {
        document: this.path,
        revision: this._model.revision,
        range: { start: 0, end: 0, total: 0 },
        content: "",
      }
    }
    const start = Math.max(1, lines.start)
    const end = Math.min(all.length, Math.max(start, lines.end))
    return {
      document: this.path,
      revision: this._model.revision,
      range: { start, end, total: all.length },
      content: all.slice(start - 1, end).join("\n"),
    }
  }

  private status(): Record<string, unknown> {
    return {
      document: this.path,
      revision: this._model.revision,
      persisted_revision: this.persistence.persistedRevision,
      dirty: this.dirty,
      save_error: this.saveError?.message ?? null,
      session: this.sessionActive,
      transactions: this._model.history.length,
    }
  }

  private applyPatch(request: Extract<ServiceRequest, { kind: "apply" }>): TransactionResult {
    const baseText = this._model.snapshot(request.baseRevision)
    const edits = editsFromUnifiedDiff(baseText, request.patch)
    return this.commit({
      actor: request.actor,
      baseRevision: request.baseRevision,
      edits,
      ...(request.message === undefined ? {} : { message: request.message }),
    })
  }

  private write(request: Extract<ServiceRequest, { kind: "write" }>): TransactionResult {
    if (request.create) {
      if (this.persistence.persistedRevision !== null || this._model.text.length > 0) {
        throw new DomainError("document_exists", `Document already exists: ${this.path}`)
      }
    } else {
      if (this.persistence.persistedRevision === null) {
        throw new DomainError("document_not_found", `Document does not exist: ${this.path}`, {
          recovery: "create it explicitly with --create",
        })
      }
      if (!request.baseRevision) throw new DomainError("bad_request", "write requires --base for an existing Document")
    }
    const baseRevision = request.baseRevision ?? this._model.revision
    if (baseRevision !== this._model.revision) {
      throw new DomainError("stale_revision", "complete replacement requires the current Revision", {
        recovery: "read the Document again before replacing all of it",
        details: { current_revision: this._model.revision },
      })
    }
    const edit = deriveSingleEdit(this._model.text, request.content)
    if (!edit) {
      if (request.create) {
        this.persistence.save(this._model.text)
        saveJournal(this.journalPath, this._model)
      }
      return { changed: false, revision: this._model.revision, transaction: null, text: this._model.text }
    }
    return this.commit({
      actor: request.actor,
      baseRevision,
      edits: [edit],
      ...(request.message === undefined ? {} : { message: request.message }),
    })
  }

  private undo(transactionId: string, actor: string, baseRevision: string): TransactionResult {
    this.persistence.assertUnchanged()
    const candidate = this._model.fork()
    const result = candidate.undo(transactionId, actor, baseRevision)
    this.persistence.save(candidate.text)
    saveJournal(this.journalPath, candidate)
    this._model = candidate
    this.dirty = false
    this.emit(result)
    return result
  }

  private commit(request: {
    actor: string
    baseRevision: string
    edits: TextEdit[]
    message?: string
  }): TransactionResult {
    this.persistence.assertUnchanged()
    const candidate = this._model.fork()
    const result = candidate.apply(request)
    if (!result.changed) return result
    this.persistence.save(candidate.text)
    saveJournal(this.journalPath, candidate)
    this._model = candidate
    this.dirty = false
    this.emit(result)
    return result
  }

  private markDirty(result: TransactionResult): void {
    if (!result.changed) return
    this.dirty = true
    this.emit(result)
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        this.flush()
      } catch (error) {
        this.saveError = error instanceof Error ? error : new Error(String(error))
        this.emitSaveError(this.saveError)
      }
    }, 120)
  }

  private emit(result: TransactionResult): void {
    if (!result.transaction) return
    for (const listener of this.listeners) listener(result.transaction)
  }

  private emitSaveError(error: Error | null): void {
    for (const listener of this.saveErrorListeners) listener(error)
  }
}

function publicTransaction(transaction: Transaction | null): PublicTransaction | null {
  if (!transaction) return null
  const { inverse: _inverse, edits, ...rest } = transaction
  return {
    ...rest,
    edits: edits.map((edit) => ({
      start: edit.start,
      end: edit.end,
      inserted: edit.text.length,
      removed: edit.end - edit.start,
    })),
  }
}

function publicMutation(result: TransactionResult): Record<string, unknown> {
  return {
    changed: result.changed,
    revision: result.revision,
    transaction: publicTransaction(result.transaction),
  }
}

function assertAgentActor(actor: string): void {
  if (actor.startsWith("human")) {
    throw new DomainError("bad_request", "the human actor namespace is reserved for TUI input", {
      recovery: "choose an agent name such as --actor codex",
    })
  }
}
