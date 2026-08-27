import { DomainError, asDomainError } from "./errors.js"

export const SCHEMA_VERSION = 1 as const

export type ErrorBody = {
  code: string
  message: string
  recovery?: string
  details?: Record<string, unknown>
}

export type Envelope<T> =
  | { schema_version: 1; ok: true; error: null; data: T }
  | { schema_version: 1; ok: false; error: ErrorBody; data: null }

export function success<T>(data: T): Envelope<T> {
  return { schema_version: SCHEMA_VERSION, ok: true, error: null, data }
}

export function failure(error: unknown): Envelope<never> {
  const domain = asDomainError(error)
  const body: ErrorBody = { code: domain.code, message: domain.message }
  if (domain.recovery !== undefined) body.recovery = domain.recovery
  if (domain.details !== undefined) body.details = domain.details
  return { schema_version: SCHEMA_VERSION, ok: false, error: body, data: null }
}

export function unwrap<T>(envelope: Envelope<T>): T {
  if (envelope.ok) return envelope.data
  throw new DomainError(envelope.error.code as DomainError["code"], envelope.error.message, {
    ...(envelope.error.recovery === undefined ? {} : { recovery: envelope.error.recovery }),
    ...(envelope.error.details === undefined ? {} : { details: envelope.error.details }),
  })
}
