import { DomainError } from "../errors.js"
import { loadJournal } from "../document/journal.js"
import { DocumentPersistence, canonicalDocumentPath, loadDocument } from "../document/persistence.js"
import { failure, success, type Envelope } from "../protocol.js"
import { activeSession, requestSession, watchSession } from "../session/ipc.js"
import { DocumentLock, documentPaths } from "../session/paths.js"
import { DocumentService, type ServiceRequest } from "../session/service.js"

export async function executeRequest<T>(
  inputPath: string,
  request: ServiceRequest,
  options: { allowMissing?: boolean } = {},
): Promise<Envelope<T>> {
  try {
    const document = canonicalDocumentPath(inputPath)
    const paths = documentPaths(document)
    const metadata = activeSession(paths.session)
    if (metadata) return await requestSession<T>(metadata, request)
    if (request.kind === "watch") {
      throw new DomainError("no_active_session", "watch requires a live TUI Session", {
        recovery: "open the Document interactively before watching it",
      })
    }

    const lock = new DocumentLock(document)
    try {
      lock.acquire()
    } catch (error) {
      const racedMetadata = activeSession(paths.session)
      if (racedMetadata) return await requestSession<T>(racedMetadata, request)
      throw error
    }
    try {
      const loaded = loadDocument(document, options.allowMissing ?? request.kind === "write")
      const model = loadJournal(paths.journal, loaded.text)
      const service = new DocumentService({
        model,
        persistence: new DocumentPersistence(loaded),
        journalPath: paths.journal,
        sessionActive: false,
      })
      const data = await service.request(request)
      return success(data as T)
    } finally {
      lock.release()
    }
  } catch (error) {
    return failure(error)
  }
}

export function executeWatch(
  inputPath: string,
  afterRevision: string | undefined,
  onLine: (line: string) => void,
): { close: () => void } {
  const document = canonicalDocumentPath(inputPath)
  const paths = documentPaths(document)
  const metadata = activeSession(paths.session)
  if (!metadata) throw new DomainError("no_active_session", "watch requires a live TUI Session")
  const request: Extract<ServiceRequest, { kind: "watch" }> = {
    kind: "watch",
    ...(afterRevision === undefined ? {} : { afterRevision }),
  }
  const socket = watchSession(metadata, request, onLine)
  return { close: () => socket.destroy() }
}
