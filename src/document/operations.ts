import { DomainError } from "../errors.js"
import { rangesOverlap, validateEdits, type TextEdit } from "./edits.js"

export type ExactTextOperation = {
  kind: "insert_before" | "insert_after" | "replace" | "delete"
  target: string
  text?: string
}

export function editsFromOperations(baseText: string, operations: readonly ExactTextOperation[]): TextEdit[] {
  if (operations.length === 0) throw new DomainError("bad_request", "at least one edit is required")

  const resolved = operations.map((operation, operationIndex) => {
    if (operation.target.length === 0) {
      throw new DomainError("bad_request", "edit targets must not be empty", {
        details: { operation_index: operationIndex },
      })
    }
    const occurrences = occurrenceOffsets(baseText, operation.target)
    if (occurrences.length === 0) {
      throw new DomainError("edit_target_not_found", "an exact edit target was not found in the base Revision", {
        recovery: "read the Document and retry with exact text from its current content",
        details: { operation_index: operationIndex },
      })
    }
    if (occurrences.length > 1) {
      throw new DomainError("ambiguous_edit", "an exact edit target occurs more than once in the base Revision", {
        recovery: "include more surrounding text so the target is unique",
        details: { operation_index: operationIndex, occurrences: occurrences.length },
      })
    }

    const targetStart = occurrences[0]!
    const targetEnd = targetStart + operation.target.length
    const requiredText = operation.kind === "delete" ? "" : operation.text
    if (requiredText === undefined) {
      throw new DomainError("bad_request", `${operation.kind} requires text`, {
        details: { operation_index: operationIndex },
      })
    }

    const edit: TextEdit =
      operation.kind === "insert_before"
        ? { start: targetStart, end: targetStart, text: requiredText }
        : operation.kind === "insert_after"
          ? { start: targetEnd, end: targetEnd, text: requiredText }
          : { start: targetStart, end: targetEnd, text: requiredText }

    return { edit, target: { start: targetStart, end: targetEnd }, operationIndex }
  })

  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      if (rangesOverlap(resolved[left]!.target, resolved[right]!.target)) {
        throw new DomainError("bad_request", "edit targets in one Transaction must not overlap", {
          details: {
            operation_indices: [resolved[left]!.operationIndex, resolved[right]!.operationIndex],
          },
        })
      }
    }
  }

  return validateEdits(baseText, resolved.map((entry) => entry.edit))
}

function occurrenceOffsets(text: string, target: string): number[] {
  const offsets: number[] = []
  let from = 0
  while (from <= text.length - target.length) {
    const offset = text.indexOf(target, from)
    if (offset === -1) break
    offsets.push(offset)
    if (offsets.length > 1) break
    from = offset + 1
  }
  return offsets
}
