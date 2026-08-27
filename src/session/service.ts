import { randomUUID } from "node:crypto"
import { DomainError } from "../errors.js"
import { deriveSingleEdit, type TextEdit } from "../document/edits.js"
import { saveJournal } from "../document/journal.js"
import { DocumentModel, type Transaction, type TransactionResult } from "../document/model.js"
import { DocumentPersistence } from "../document/persistence.js"
import { editsFromUnifiedDiff } from "../document/unified-diff.js"

export type ChangeEvent = {
  schema_version: 1
  type: "revision"
  document: string
  revision: string
  transaction: PublicTransaction | null
}

export type PublicTransaction = Omit<Transaction, "edits" | "inverse"> & {
  edits: Array<{ start: number; end: number; inserted: number; removed: number }>
}

export type Proposal = {
  id: string
  actor: string
  baseRevision: string
  patch: string
  message: string | null
  createdAt: string
}

export type ServiceRequest =
  | { kind: "read"; lines?: { start: number; end: number } }
  | { kind: "search"; query: string; ignoreCase?: boolean }
  | { kind: "status" }
  | { kind: "history" }
  | { kind: "apply"; baseRevision: string; patch: string; actor: string; message?: string; propose?: boolean }
  | { kind: "write"; baseRevision?: string; content: string; actor: string; message?: string; create?: boolean }
  | { kind: "undo"; baseRevision: string; transactionId: string; actor: string }
  | { kind: "watch"; afterRevision?: string }

export class DocumentService {
  private _model: DocumentModel
  private readonly persistence: DocumentPersistence
  private readonly journalPath: string
  private readonly sessionActive: boolean
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveError: Error | null = null
  private readonly listeners = new Set<(event: ChangeEvent) => void>()
  private readonly saveErrorListeners = new Set<(error: Error | null) => void>()
  private readonly proposals = new Map<string, Proposal>()

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

  get pendingProposals(): readonly Proposal[] {
    return [...this.proposals.values()]
  }

  async request(request: ServiceRequest): Promise<unknown> {
    switch (request.kind) {
      case "read":
        return this.read(request.lines)
      case "search":
        return this.search(request.query, request.ignoreCase ?? false)
      case "status":
        return this.status()
      case "history":
        return { revision: this._model.revision, transactions: this._model.history.map(publicTransaction) }
      case "apply":
        assertAgentActor(request.actor)
        if (request.propose) return this.propose(request)
        return publicMutation(this.applyPatch(request))
      case "write":
        assertAgentActor(request.actor)
        return publicMutation(this.write(request))
      case "undo":
        assertAgentActor(request.actor)
        return publicMutation(this.undo(request))
      case "watch":
        throw new DomainError("bad_request", "watch is a streaming request")
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
    return this.undo({
      kind: "undo",
      transactionId,
      baseRevision: this._model.revision,
      actor,
    })
  }

  acceptProposal(id: string): TransactionResult {
    const proposal = this.proposals.get(id)
    if (!proposal) throw new DomainError("transaction_not_found", `Proposal ${id} does not exist`)
    const result = this.applyPatch(
      {
        kind: "apply",
        baseRevision: proposal.baseRevision,
        patch: proposal.patch,
        actor: proposal.actor,
        ...(proposal.message === null ? {} : { message: proposal.message }),
      },
      true,
    )
    this.proposals.delete(id)
    return result
  }

  rejectProposal(id: string): boolean {
    return this.proposals.delete(id)
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSaveError(listener: (error: Error | null) => void): () => void {
    this.saveErrorListeners.add(listener)
    return () => this.saveErrorListeners.delete(listener)
  }

  currentEvent(): ChangeEvent {
    return {
      schema_version: 1,
      type: "revision",
      document: this.path,
      revision: this._model.revision,
      transaction: publicTransaction(this._model.latestTransaction()),
    }
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

  private search(query: string, ignoreCase: boolean): Record<string, unknown> {
    if (query.length === 0) throw new DomainError("bad_request", "search query must not be empty")
    const needle = ignoreCase ? query.toLocaleLowerCase() : query
    const matches: Array<{ line: number; column: number; preview: string }> = []
    for (const [index, line] of this._model.text.split("\n").entries()) {
      const haystack = ignoreCase ? line.toLocaleLowerCase() : line
      let offset = 0
      while (matches.length < 500) {
        const column = haystack.indexOf(needle, offset)
        if (column === -1) break
        matches.push({ line: index + 1, column: column + 1, preview: line })
        offset = column + Math.max(needle.length, 1)
      }
      if (matches.length >= 500) break
    }
    return { document: this.path, revision: this._model.revision, query, matches, truncated: matches.length >= 500 }
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
      proposals: this.proposals.size,
    }
  }

  private propose(request: Extract<ServiceRequest, { kind: "apply" }>): Record<string, unknown> {
    if (!this.sessionActive) {
      throw new DomainError("no_active_session", "a Proposal requires a human TUI Session", {
        recovery: "open the Document interactively, or apply the guarded Transaction directly",
      })
    }
    editsFromUnifiedDiff(this._model.snapshot(request.baseRevision), request.patch)
    const proposal: Proposal = {
      id: `proposal_${randomUUID().replaceAll("-", "")}`,
      actor: request.actor,
      baseRevision: request.baseRevision,
      patch: request.patch,
      message: request.message ?? null,
      createdAt: new Date().toISOString(),
    }
    this.proposals.set(proposal.id, proposal)
    return {
      proposal: {
        id: proposal.id,
        actor: proposal.actor,
        baseRevision: proposal.baseRevision,
        message: proposal.message,
        createdAt: proposal.createdAt,
      },
      revision: this._model.revision,
    }
  }

  private applyPatch(
    request: Extract<ServiceRequest, { kind: "apply" }>,
    ignoreActiveRegion = false,
  ): TransactionResult {
    const baseText = this._model.snapshot(request.baseRevision)
    const edits = editsFromUnifiedDiff(baseText, request.patch)
    return this.commit({
      actor: request.actor,
      baseRevision: request.baseRevision,
      edits,
      ignoreActiveRegion,
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

  private undo(request: Extract<ServiceRequest, { kind: "undo" }>): TransactionResult {
    this.persistence.assertUnchanged()
    const candidate = this._model.fork()
    const result = candidate.undo(request.transactionId, request.actor, request.baseRevision)
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
    ignoreActiveRegion?: boolean
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
    const event: ChangeEvent = {
      schema_version: 1,
      type: "revision",
      document: this.path,
      revision: result.revision,
      transaction: publicTransaction(result.transaction),
    }
    for (const listener of this.listeners) listener(event)
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
