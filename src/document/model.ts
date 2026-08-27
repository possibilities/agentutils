import { randomUUID } from "node:crypto"
import { DomainError } from "../errors.js"
import {
  applyEdits,
  invertEdits,
  rangesOverlap,
  transformEdits,
  validateEdits,
  type TextEdit,
} from "./edits.js"
import { revisionOf } from "./revision.js"

export type Actor = string

export type Transaction = {
  id: string
  actor: Actor
  message: string | null
  at: string
  baseRevision: string
  fromRevision: string
  toRevision: string
  edits: TextEdit[]
  inverse: TextEdit[]
  rebased: boolean
  reverts: string | null
}

export type TransactionRequest = {
  actor: Actor
  baseRevision: string
  edits: TextEdit[]
  message?: string
  reverts?: string
  ignoreActiveRegion?: boolean
}

export type TransactionResult = {
  changed: boolean
  revision: string
  transaction: Transaction | null
  text: string
}

type RevisionEntry = { text: string; transactionIndex: number }

export type SerializedDocumentModel = {
  schemaVersion: 1
  checkpoint: { revision: string; text: string }
  transactions: Transaction[]
  currentRevision: string
}

export class DocumentModel {
  private _text: string
  private _revision: string
  private readonly transactions: Transaction[] = []
  private readonly revisions = new Map<string, RevisionEntry>()
  private activeRegion: { start: number; end: number; expiresAt: number } | null = null

  constructor(text: string) {
    this._text = text
    this._revision = revisionOf(text)
    this.revisions.set(this._revision, { text, transactionIndex: 0 })
  }

  static restore(currentText: string, serialized: SerializedDocumentModel): DocumentModel {
    if (serialized.schemaVersion !== 1 || serialized.currentRevision !== revisionOf(currentText)) {
      return new DocumentModel(currentText)
    }

    const model = new DocumentModel(serialized.checkpoint.text)
    if (model.revision !== serialized.checkpoint.revision) return new DocumentModel(currentText)

    for (const transaction of serialized.transactions) {
      if (model.revision !== transaction.fromRevision) return new DocumentModel(currentText)
      const nextText = applyEdits(model.text, transaction.edits)
      if (revisionOf(nextText) !== transaction.toRevision) return new DocumentModel(currentText)
      model._text = nextText
      model._revision = transaction.toRevision
      model.transactions.push(transaction)
      model.revisions.set(transaction.toRevision, {
        text: nextText,
        transactionIndex: model.transactions.length,
      })
    }

    return model.revision === serialized.currentRevision ? model : new DocumentModel(currentText)
  }

  get text(): string {
    return this._text
  }

  get revision(): string {
    return this._revision
  }

  get history(): readonly Transaction[] {
    return this.transactions
  }

  snapshot(revision = this._revision): string {
    const entry = this.revisions.get(revision)
    if (!entry) {
      throw new DomainError("stale_revision", `Revision ${revision} is no longer available`, {
        recovery: "read the Document again and rebuild the Transaction against its current Revision",
        details: { current_revision: this._revision },
      })
    }
    return entry.text
  }

  setActiveRegion(start: number, end: number, durationMs = 1_500): void {
    const safeStart = Math.max(0, Math.min(start, this._text.length))
    const safeEnd = Math.max(safeStart, Math.min(end, this._text.length))
    this.activeRegion = { start: safeStart, end: safeEnd, expiresAt: Date.now() + durationMs }
  }

  clearActiveRegion(): void {
    this.activeRegion = null
  }

  apply(request: TransactionRequest): TransactionResult {
    const base = this.revisions.get(request.baseRevision)
    if (!base) return this.missingRevision(request.baseRevision)

    let edits = validateEdits(base.text, request.edits)
    const rebased = request.baseRevision !== this._revision

    if (rebased) {
      const intervening = this.transactions.slice(base.transactionIndex)
      for (const transaction of intervening) {
        const transformed = transformEdits(edits, transaction.edits)
        if (transformed.conflict) {
          throw new DomainError("edit_conflict", "the Transaction overlaps work added after its base Revision", {
            recovery: "read the current Document and submit a new Transaction",
            details: {
              current_revision: this._revision,
              conflicting_transaction: transaction.id,
              conflict: transformed.conflict,
            },
          })
        }
        edits = transformed.edits
      }
    }

    if (!request.ignoreActiveRegion && !request.actor.startsWith("human")) {
      const region = this.currentActiveRegion()
      if (region && edits.some((edit) => rangesOverlap(edit, region))) {
        throw new DomainError("edit_conflict", "the Transaction overlaps the human's Active region", {
          recovery: "wait for the human to leave the region, or submit a Proposal",
          details: { current_revision: this._revision, active_region: region },
        })
      }
    }

    if (edits.length === 0) return { changed: false, revision: this._revision, transaction: null, text: this._text }
    const nextText = applyEdits(this._text, edits)
    if (nextText === this._text) {
      return { changed: false, revision: this._revision, transaction: null, text: this._text }
    }

    const fromRevision = this._revision
    const inverse = invertEdits(this._text, edits)
    const toRevision = revisionOf(nextText)
    const transaction: Transaction = {
      id: `tx_${randomUUID().replaceAll("-", "")}`,
      actor: request.actor,
      message: request.message ?? null,
      at: new Date().toISOString(),
      baseRevision: request.baseRevision,
      fromRevision,
      toRevision,
      edits,
      inverse,
      rebased,
      reverts: request.reverts ?? null,
    }

    this._text = nextText
    this._revision = toRevision
    this.transactions.push(transaction)
    this.revisions.set(toRevision, { text: nextText, transactionIndex: this.transactions.length })
    this.pruneRevisions()

    return { changed: true, revision: toRevision, transaction, text: nextText }
  }

  undo(transactionId: string, actor: Actor, baseRevision: string): TransactionResult {
    if (baseRevision !== this._revision) {
      throw new DomainError("stale_revision", "undo must start from the current Revision", {
        recovery: "read status and retry with its current Revision",
        details: { current_revision: this._revision },
      })
    }
    const target = this.transactions.find((transaction) => transaction.id === transactionId)
    if (!target) {
      throw new DomainError("transaction_not_found", `Transaction ${transactionId} is not in this Session's history`)
    }
    try {
      return this.apply({
        actor,
        baseRevision: target.toRevision,
        edits: target.inverse,
        message: `undo ${target.id}`,
        reverts: target.id,
        ignoreActiveRegion: actor.startsWith("human"),
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === "edit_conflict") {
        throw new DomainError("undo_conflict", `Transaction ${transactionId} cannot be undone without touching later work`, {
          recovery: "review history and create an explicit new Transaction",
          ...(error.details === undefined ? {} : { details: error.details }),
        })
      }
      throw error
    }
  }

  latestTransaction(actorPrefix?: string): Transaction | null {
    for (let index = this.transactions.length - 1; index >= 0; index -= 1) {
      const transaction = this.transactions[index]!
      if (!actorPrefix || transaction.actor.startsWith(actorPrefix)) return transaction
    }
    return null
  }

  serialize(maxTransactions = 256): SerializedDocumentModel {
    const startIndex = Math.max(0, this.transactions.length - maxTransactions)
    const checkpointRevision =
      startIndex === 0 ? this.transactions[0]?.fromRevision ?? this._revision : this.transactions[startIndex - 1]!.toRevision
    const checkpoint = this.revisions.get(checkpointRevision)
    if (!checkpoint) throw new Error(`missing checkpoint ${checkpointRevision}`)
    return {
      schemaVersion: 1,
      checkpoint: { revision: checkpointRevision, text: checkpoint.text },
      transactions: this.transactions.slice(startIndex),
      currentRevision: this._revision,
    }
  }

  fork(): DocumentModel {
    const clone = DocumentModel.restore(this._text, this.serialize())
    clone.activeRegion = this.activeRegion ? { ...this.activeRegion } : null
    return clone
  }

  private currentActiveRegion(): { start: number; end: number } | null {
    if (!this.activeRegion) return null
    if (this.activeRegion.expiresAt <= Date.now()) {
      this.activeRegion = null
      return null
    }
    return { start: this.activeRegion.start, end: this.activeRegion.end }
  }

  private missingRevision(revision: string): never {
    throw new DomainError("stale_revision", `Revision ${revision} is not available`, {
      recovery: "read the Document again and rebuild the Transaction against its current Revision",
      details: { current_revision: this._revision },
    })
  }

  private pruneRevisions(): void {
    const keep = 256
    if (this.transactions.length <= keep) return
    const oldestIndex = this.transactions.length - keep
    for (const [revision, entry] of this.revisions) {
      if (entry.transactionIndex < oldestIndex && revision !== this._revision) this.revisions.delete(revision)
    }
  }
}
