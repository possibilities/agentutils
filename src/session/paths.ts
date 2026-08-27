import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DomainError } from "../errors.js"

export type SessionMetadata = {
  schema_version: 1
  document: string
  socket: string
  pid: number
  token: string
}

export type DocumentPaths = {
  key: string
  runtimeRoot: string
  stateRoot: string
  lock: string
  owner: string
  socket: string
  session: string
  journal: string
}

export function documentPaths(document: string): DocumentPaths {
  const key = createHash("sha256").update(document).digest("hex").slice(0, 32)
  const runtimeRoot = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, "agenteditor")
    : join(tmpdir(), `agenteditor-${process.getuid?.() ?? "user"}`)
  const stateRoot = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agenteditor")
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  chmodSync(runtimeRoot, 0o700)
  chmodSync(stateRoot, 0o700)
  return {
    key,
    runtimeRoot,
    stateRoot,
    lock: join(runtimeRoot, `${key}.lock`),
    owner: join(runtimeRoot, `${key}.lock`, "owner.json"),
    socket: join(runtimeRoot, `${key}.sock`),
    session: join(runtimeRoot, `${key}.session.json`),
    journal: join(stateRoot, `${key}.journal.json`),
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class DocumentLock {
  readonly token = randomUUID()
  readonly paths: DocumentPaths
  private held = false

  constructor(document: string) {
    this.paths = documentPaths(document)
  }

  acquire(): void {
    try {
      mkdirSync(this.paths.lock, { mode: 0o700 })
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error
      const owner = readOwner(this.paths.owner)
      if (owner && pidAlive(owner.pid)) {
        throw new DomainError("no_active_session", "the Document is already held by another process", {
          recovery: "connect to its active Session or wait for that process to exit",
          details: { pid: owner.pid },
        })
      }
      rmSync(this.paths.lock, { recursive: true, force: true })
      mkdirSync(this.paths.lock, { mode: 0o700 })
    }
    writeFileSync(this.paths.owner, JSON.stringify({ pid: process.pid, token: this.token }), { mode: 0o600 })
    this.held = true
  }

  release(): void {
    if (!this.held) return
    const owner = readOwner(this.paths.owner)
    if (owner?.token === this.token) rmSync(this.paths.lock, { recursive: true, force: true })
    this.held = false
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

export function readSessionMetadata(path: string): SessionMetadata | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionMetadata
    if (parsed.schema_version !== 1 || !pidAlive(parsed.pid)) return null
    return parsed
  } catch {
    return null
  }
}

function readOwner(path: string): { pid: number; token: string } | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid: number; token: string }
    return Number.isSafeInteger(value.pid) && typeof value.token === "string" ? value : null
  } catch {
    return null
  }
}
