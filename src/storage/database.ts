import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import type { Configuration } from "../catalog.js"
import { DomainError } from "../errors.js"
import { DocumentModel, type SerializedDocumentModel } from "../document/model.js"

export const SURFACE_MODES = ["standby", "document", "document_configuration", "configuration"] as const
export type SurfaceMode = (typeof SURFACE_MODES)[number]

export type ViewState = {
  cursor: number
  selectionStart: number | null
  selectionEnd: number | null
  viewportX: number
  viewportY: number
}

export const EMPTY_VIEW_STATE: ViewState = {
  cursor: 0,
  selectionStart: null,
  selectionEnd: null,
  viewportX: 0,
  viewportY: 0,
}

export type StoredDocument = {
  id: string
  title: string
  content: string
  revision: string
  serialized: SerializedDocumentModel
  configuration: Configuration
  view: ViewState
  createdAt: string
  updatedAt: string
}

export type DocumentSummary = Omit<StoredDocument, "content" | "serialized" | "view">

export type StoredSurface = {
  focusedDocumentId: string | null
  mode: SurfaceMode
}

type DocumentRow = {
  id: string
  title: string
  content: string
  revision: string
  model_json: string
  model_id: string | null
  effort: string | null
  cursor_offset: number
  selection_start: number | null
  selection_end: number | null
  viewport_x: number
  viewport_y: number
  created_at: string
  updated_at: string
}

type SurfaceRow = {
  focused_document_id: string | null
  mode: string
}

export function defaultDatabasePath(): string {
  const explicitRoot = process.env.AGENTUTILS_EDITOR_STATE_DIR
  const stateRoot = explicitRoot ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agentutils")
  return join(stateRoot, "editor.sqlite3")
}

export class DocumentStore {
  private readonly database: Database

  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
    }
    this.database = new Database(path, { create: true, strict: true })
    this.database.exec("PRAGMA foreign_keys = ON")
    this.database.exec("PRAGMA journal_mode = WAL")
    this.database.exec("PRAGMA synchronous = FULL")
    this.database.exec("PRAGMA busy_timeout = 1000")
    this.createSchema()
    if (path !== ":memory:") chmodSync(path, 0o600)
  }

  close(): void {
    this.database.close()
  }

  createDocument(input: {
    title: string
    content: string
    configuration: Configuration
  }): StoredDocument {
    const id = `doc_${randomUUID().replaceAll("-", "")}`
    const now = new Date().toISOString()
    const model = new DocumentModel(input.content)
    this.database
      .query(
        `INSERT INTO documents (
          id, title, content, revision, model_json, model_id, effort,
          cursor_offset, selection_start, selection_end, viewport_x, viewport_y,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, 0, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.content,
        model.revision,
        JSON.stringify(model.serialize()),
        input.configuration.model,
        input.configuration.effort,
        now,
        now,
      )
    return this.getDocument(id)
  }

  listDocuments(): DocumentSummary[] {
    const rows = this.database
      .query<DocumentRow, []>("SELECT * FROM documents ORDER BY updated_at DESC, created_at DESC")
      .all()
    return rows.map((row) => {
      const document = rowToDocument(row)
      const { content: _content, serialized: _serialized, view: _view, ...summary } = document
      return summary
    })
  }

  getDocument(id: string): StoredDocument {
    const row = this.database.query<DocumentRow, [string]>("SELECT * FROM documents WHERE id = ?").get(id)
    if (!row) {
      throw new DomainError("document_not_found", "the requested Document does not exist", {
        recovery: "call list_documents and choose an available Document ID",
      })
    }
    return rowToDocument(row)
  }

  saveRuntime(id: string, model: DocumentModel, view: ViewState, contentChanged: boolean): StoredDocument {
    const now = new Date().toISOString()
    const result = this.database
      .query(
        `UPDATE documents SET
          content = ?, revision = ?, model_json = ?, cursor_offset = ?,
          selection_start = ?, selection_end = ?, viewport_x = ?, viewport_y = ?,
          updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END
        WHERE id = ?`,
      )
      .run(
        model.text,
        model.revision,
        JSON.stringify(model.serialize()),
        view.cursor,
        view.selectionStart,
        view.selectionEnd,
        view.viewportX,
        view.viewportY,
        contentChanged ? 1 : 0,
        now,
        id,
      )
    if (result.changes !== 1) return this.getDocument(id)
    return this.getDocument(id)
  }

  setConfiguration(id: string, configuration: Configuration): StoredDocument {
    const result = this.database
      .query("UPDATE documents SET model_id = ?, effort = ?, updated_at = ? WHERE id = ?")
      .run(configuration.model, configuration.effort, new Date().toISOString(), id)
    if (result.changes !== 1) return this.getDocument(id)
    return this.getDocument(id)
  }

  getSurface(): StoredSurface {
    const row = this.database
      .query<SurfaceRow, []>("SELECT focused_document_id, mode FROM surface_state WHERE singleton = 1")
      .get()
    if (!row) return { focusedDocumentId: null, mode: "standby" }
    const mode = SURFACE_MODES.includes(row.mode as SurfaceMode) ? (row.mode as SurfaceMode) : "standby"
    return {
      focusedDocumentId: row.focused_document_id,
      mode: row.focused_document_id === null ? "standby" : mode,
    }
  }

  setSurface(surface: StoredSurface): void {
    this.database
      .query("UPDATE surface_state SET focused_document_id = ?, mode = ? WHERE singleton = 1")
      .run(surface.focusedDocumentId, surface.mode)
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        revision TEXT NOT NULL,
        model_json TEXT NOT NULL,
        model_id TEXT,
        effort TEXT,
        cursor_offset INTEGER NOT NULL DEFAULT 0,
        selection_start INTEGER,
        selection_end INTEGER,
        viewport_x INTEGER NOT NULL DEFAULT 0,
        viewport_y INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS surface_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        focused_document_id TEXT REFERENCES documents(id),
        mode TEXT NOT NULL
      );
      INSERT OR IGNORE INTO surface_state (singleton, focused_document_id, mode)
        VALUES (1, NULL, 'standby');
      PRAGMA user_version = 1;
    `)
  }
}

function rowToDocument(row: DocumentRow): StoredDocument {
  let serialized: SerializedDocumentModel
  try {
    serialized = JSON.parse(row.model_json) as SerializedDocumentModel
  } catch {
    serialized = new DocumentModel(row.content).serialize()
  }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    revision: row.revision,
    serialized,
    configuration: { model: row.model_id, effort: row.effort },
    view: {
      cursor: row.cursor_offset,
      selectionStart: row.selection_start,
      selectionEnd: row.selection_end,
      viewportX: row.viewport_x,
      viewportY: row.viewport_y,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
