import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { DomainError } from "../errors.js"
import { revisionOf } from "./revision.js"

export function canonicalDocumentPath(input: string): string {
  const absolute = resolve(input)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = realpathSync(dirname(absolute))
  return join(parent, basename(absolute))
}

export type LoadedDocument = {
  path: string
  text: string
  exists: boolean
  diskRevision: string | null
}

export function loadDocument(input: string, allowMissing = false): LoadedDocument {
  const path = canonicalDocumentPath(input)
  if (!existsSync(path)) {
    if (!allowMissing) {
      throw new DomainError("document_not_found", `Document does not exist: ${path}`, {
        recovery: "create it with `agenteditor write PATH --create`, or open it interactively",
      })
    }
    return { path, text: "", exists: false, diskRevision: null }
  }
  if (!lstatSync(path).isFile()) throw new DomainError("bad_request", `Document is not a regular file: ${path}`)
  const text = readUtf8(path)
  return { path, text, exists: true, diskRevision: revisionOf(text) }
}

export class DocumentPersistence {
  readonly path: string
  private diskRevision: string | null

  constructor(loaded: LoadedDocument) {
    this.path = loaded.path
    this.diskRevision = loaded.diskRevision
  }

  get persistedRevision(): string | null {
    return this.diskRevision
  }

  assertUnchanged(): void {
    const exists = existsSync(this.path)
    const current = exists ? revisionOf(readUtf8(this.path)) : null
    if (current !== this.diskRevision) {
      throw new DomainError("external_change", "the Document changed outside agenteditor", {
        recovery: "read the external contents, then reopen agenteditor or reconcile them explicitly",
        details: { expected_revision: this.diskRevision, disk_revision: current },
      })
    }
  }

  save(text: string): string {
    this.assertUnchanged()
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true })
    const temporary = join(directory, `.${basename(this.path)}.agenteditor-${process.pid}-${randomUUID()}`)
    const mode = existsSync(this.path) ? statSync(this.path).mode & 0o777 : 0o666 & ~process.umask()
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, "wx", 0o600)
      writeFileSync(descriptor, text, "utf8")
      fsyncSync(descriptor)
      chmodSync(temporary, mode)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, this.path)
      const directoryDescriptor = openSync(directory, "r")
      try {
        fsyncSync(directoryDescriptor)
      } finally {
        closeSync(directoryDescriptor)
      }
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor)
      if (existsSync(temporary)) unlinkSync(temporary)
      throw error
    }
    this.diskRevision = revisionOf(text)
    return this.diskRevision
  }
}

function readUtf8(path: string): string {
  const bytes = readFileSync(path)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new DomainError("bad_request", `Document is not valid UTF-8: ${path}`, {
      recovery: "convert the file to UTF-8 before opening it in agenteditor",
    })
  }
}
