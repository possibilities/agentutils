import { DomainError } from "../errors.js"
import { applyEdits, type TextEdit } from "./edits.js"

type SourceLine = { start: number; end: number; content: string; newline: string }
type PatchLine = { kind: "context" | "remove" | "add"; content: string; noNewline: boolean }
type Hunk = { oldStart: number; oldCount: number; newCount: number; lines: PatchLine[] }

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start)
    if (newlineIndex === -1) {
      lines.push({ start, end: text.length, content: text.slice(start), newline: "" })
      break
    }
    const contentEnd = newlineIndex > start && text[newlineIndex - 1] === "\r" ? newlineIndex - 1 : newlineIndex
    lines.push({
      start,
      end: newlineIndex + 1,
      content: text.slice(start, contentEnd),
      newline: text.slice(contentEnd, newlineIndex + 1),
    })
    start = newlineIndex + 1
  }
  return lines
}

function parsePatch(patch: string): Hunk[] {
  const rows = patch.replaceAll("\r\n", "\n").split("\n")
  const hunks: Hunk[] = []
  let current: Hunk | null = null

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (row === "\\ No newline at end of file") {
      const previous = current.lines.at(-1)
      if (!previous) throw new DomainError("invalid_patch", "no-newline marker has no preceding hunk line")
      previous.noNewline = true
      continue
    }
    const prefix = row[0]
    if (prefix === " " || prefix === "-" || prefix === "+") {
      current.lines.push({
        kind: prefix === " " ? "context" : prefix === "-" ? "remove" : "add",
        content: row.slice(1),
        noNewline: false,
      })
      continue
    }
    if (row === "" && index === rows.length - 1) continue
    throw new DomainError("invalid_patch", `unexpected line inside hunk: ${row}`)
  }

  if (hunks.length === 0) throw new DomainError("invalid_patch", "the input contains no unified-diff hunks")
  return hunks
}

export function editsFromUnifiedDiff(baseText: string, patch: string): TextEdit[] {
  const source = sourceLines(baseText)
  const newline = source.find((line) => line.newline)?.newline ?? "\n"
  const hunks = parsePatch(patch)
  const edits: TextEdit[] = []

  for (const hunk of hunks) {
    let sourceIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    let observedOld = 0
    let observedNew = 0
    let groupStart: number | null = null
    let removed: SourceLine[] = []
    let added: PatchLine[] = []

    const flush = () => {
      if (groupStart === null) return
      const start = source[groupStart]?.start ?? baseText.length
      const end = removed.at(-1)?.end ?? start
      const replacement = added
        .map((line) => line.content + (line.noNewline ? "" : newline))
        .join("")
      edits.push({ start, end, text: replacement })
      groupStart = null
      removed = []
      added = []
    }

    for (const line of hunk.lines) {
      if (line.kind === "context") {
        flush()
        const actual = source[sourceIndex]
        if (!actual || actual.content !== line.content) {
          throw new DomainError("invalid_patch", `context does not match line ${sourceIndex + 1}`, {
            details: { expected: line.content, actual: actual?.content ?? null },
          })
        }
        sourceIndex += 1
        observedOld += 1
        observedNew += 1
        continue
      }
      if (groupStart === null) groupStart = sourceIndex
      if (line.kind === "remove") {
        const actual = source[sourceIndex]
        if (!actual || actual.content !== line.content) {
          throw new DomainError("invalid_patch", `removed text does not match line ${sourceIndex + 1}`, {
            details: { expected: line.content, actual: actual?.content ?? null },
          })
        }
        removed.push(actual)
        sourceIndex += 1
        observedOld += 1
      } else {
        added.push(line)
        observedNew += 1
      }
    }
    flush()

    if (observedOld !== hunk.oldCount || observedNew !== hunk.newCount) {
      throw new DomainError("invalid_patch", "hunk line counts do not match its header", {
        details: {
          expected_old: hunk.oldCount,
          observed_old: observedOld,
          expected_new: hunk.newCount,
          observed_new: observedNew,
        },
      })
    }
  }

  applyEdits(baseText, edits)
  return edits
}
