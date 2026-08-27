export type ErrorCode =
  | "bad_request"
  | "document_exists"
  | "document_not_found"
  | "edit_conflict"
  | "external_change"
  | "invalid_patch"
  | "no_active_session"
  | "stale_revision"
  | "transaction_not_found"
  | "undo_conflict"

export class DomainError extends Error {
  readonly code: ErrorCode
  readonly recovery: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: ErrorCode,
    message: string,
    options: { recovery?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = "DomainError"
    this.code = code
    this.recovery = options.recovery
    this.details = options.details
  }
}

export function asDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  return new DomainError("bad_request", error instanceof Error ? error.message : String(error))
}
