import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { DocumentModel, type SerializedDocumentModel } from "./model.js"

export function loadJournal(path: string, currentText: string): DocumentModel {
  if (!existsSync(path)) return new DocumentModel(currentText)
  try {
    const serialized = JSON.parse(readFileSync(path, "utf8")) as SerializedDocumentModel
    return DocumentModel.restore(currentText, serialized)
  } catch {
    return new DocumentModel(currentText)
  }
}

export function saveJournal(path: string, model: DocumentModel): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(model.serialize()), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
}
