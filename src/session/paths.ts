import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
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
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM"
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
    const candidate = `${this.paths.lock}.${process.pid}.${this.token}.candidate`
    mkdirSync(candidate, { mode: 0o700 })
    writeFileSync(
      join(candidate, "owner.json"),
      JSON.stringify({ pid: process.pid, token: this.token }),
      { mode: 0o600 },
    )
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (existsSync(this.paths.lock)) {
          const owner = readOwner(this.paths.owner)
          if (!owner) {
            throw new DomainError("no_active_session", "the Document lock has no verifiable owner", {
              recovery: "verify that no agenteditor process is using the Document, then remove the stale lock",
            })
          }
          if (pidAlive(owner.pid)) {
            throw new DomainError("no_active_session", "the Document is already held by another process", {
              recovery: "connect to its active Session or wait for that process to exit",
              details: { pid: owner.pid },
            })
          }
          this.reap(owner)
          continue
        }

        try {
          renameSync(candidate, this.paths.lock)
          this.held = true
          return
        } catch (error) {
          if (!lockExistsError(error)) throw error
        }
      }
      throw new DomainError("no_active_session", "the Document lock changed while it was being acquired", {
        recovery: "retry the operation",
      })
    } finally {
      if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true })
    }
  }

  release(): void {
    if (!this.held) return
    const owner = readOwner(this.paths.owner)
    if (owner?.token === this.token) rmSync(this.paths.lock, { recursive: true, force: true })
    this.held = false
  }

  private reap(expected: { pid: number; token: string }): void {
    const marker = join(this.paths.lock, ".reap")
    try {
      writeFileSync(marker, this.token, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) {
        throw new DomainError("no_active_session", "the stale Document lock is already being recovered", {
          recovery: "retry the operation",
        })
      }
      throw error
    }

    const current = readOwner(this.paths.owner)
    if (!current || current.pid !== expected.pid || current.token !== expected.token || pidAlive(current.pid)) {
      if (existsSync(marker)) unlinkSync(marker)
      throw new DomainError("no_active_session", "the Document lock changed while it was being recovered", {
        recovery: "retry the operation",
      })
    }

    const stale = `${this.paths.lock}.${this.token}.stale`
    try {
      renameSync(this.paths.lock, stale)
      rmSync(stale, { recursive: true, force: true })
    } catch (error) {
      if (existsSync(marker)) unlinkSync(marker)
      if (existsSync(stale)) rmSync(stale, { recursive: true, force: true })
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function lockExistsError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")
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
