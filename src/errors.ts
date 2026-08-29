export type ErrorCode =
  | "ambiguous_edit"
  | "bad_request"
  | "catalog_unavailable"
  | "document_not_found"
  | "edit_conflict"
  | "edit_target_not_found"
  | "internal_error"
  | "invalid_configuration"
  | "no_focused_document"
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
  return new DomainError("internal_error", "agenteditor could not complete the operation", {
    recovery: "retry once; if the failure persists, inspect the running Surface",
  })
}
