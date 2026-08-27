import { DomainError } from "../errors.js"

export type TextEdit = {
  start: number
  end: number
  text: string
}

export type EditConflict = {
  incoming: { start: number; end: number }
  intervening: { start: number; end: number }
}

export function validateEdits(text: string, edits: readonly TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  let previousEnd = 0
  for (const [index, edit] of sorted.entries()) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)) {
      throw new DomainError("bad_request", "edit offsets must be safe integers")
    }
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new DomainError("bad_request", `edit range ${edit.start}:${edit.end} is outside the Document`, {
        details: { length: text.length },
      })
    }
    if (index > 0 && edit.start < previousEnd) {
      throw new DomainError("bad_request", "edits in one Transaction must not overlap")
    }
    previousEnd = edit.end
  }
  return sorted
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = validateEdits(text, edits)
  let result = text
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const edit = sorted[index]!
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

export function deriveSingleEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null

  let start = 0
  const sharedLength = Math.min(before.length, after.length)
  while (start < sharedLength && before.charCodeAt(start) === after.charCodeAt(start)) start += 1

  let beforeEnd = before.length
  let afterEnd = after.length
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  return { start, end: beforeEnd, text: after.slice(start, afterEnd) }
}

export function invertEdits(before: string, edits: readonly TextEdit[]): TextEdit[] {
  const sorted = validateEdits(before, edits)
  let delta = 0
  return sorted.map((edit) => {
    const start = edit.start + delta
    const inverse = {
      start,
      end: start + edit.text.length,
      text: before.slice(edit.start, edit.end),
    }
    delta += edit.text.length - (edit.end - edit.start)
    return inverse
  })
}

export function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  if (left.start === left.end) return left.start > right.start && left.start < right.end
  if (right.start === right.end) return right.start > left.start && right.start < left.end
  return left.start < right.end && right.start < left.end
}

export function transformEdits(
  incoming: readonly TextEdit[],
  intervening: readonly TextEdit[],
): { edits: TextEdit[]; conflict: EditConflict | null } {
  const transformed: TextEdit[] = []

  for (const original of incoming) {
    let start = original.start
    let end = original.end
    let shift = 0

    for (const applied of intervening) {
      const insertion = applied.start === applied.end
      const safelyBefore = insertion ? applied.start <= original.start : applied.end <= original.start
      const safelyAfter = applied.start >= original.end

      if (safelyBefore) {
        shift += applied.text.length - (applied.end - applied.start)
        continue
      }
      if (safelyAfter) continue

      return {
        edits: [],
        conflict: {
          incoming: { start: original.start, end: original.end },
          intervening: { start: applied.start, end: applied.end },
        },
      }
    }

    start += shift
    end += shift
    transformed.push({ start, end, text: original.text })
  }

  return { edits: transformed, conflict: null }
}

export function transformOffset(offset: number, edits: readonly TextEdit[], affinity: "before" | "after" = "after"): number {
  let transformed = offset
  for (const edit of edits) {
    const removed = edit.end - edit.start
    const delta = edit.text.length - removed
    if (edit.end < offset || (edit.end === offset && (removed > 0 || affinity === "after"))) {
      transformed += delta
      continue
    }
    if (edit.start < offset && offset < edit.end) {
      transformed = edit.start + (affinity === "after" ? edit.text.length : 0)
    }
  }
  return Math.max(0, transformed)
}
