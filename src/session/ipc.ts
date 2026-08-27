import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { DomainError } from "../errors.js"
import { failure, success, type Envelope } from "../protocol.js"
import type { ServiceRequest } from "./service.js"
import { DocumentService } from "./service.js"
import { DocumentLock, readSessionMetadata, type SessionMetadata } from "./paths.js"

type WireRequest = { token: string; request: ServiceRequest }

export class SessionServer {
  private readonly service: DocumentService
  private readonly lock: DocumentLock
  private server: Server | null = null
  private metadata: SessionMetadata | null = null
  private readonly sockets = new Set<Socket>()

  constructor(service: DocumentService, lock: DocumentLock) {
    this.service = service
    this.lock = lock
  }

  async start(): Promise<void> {
    const { paths } = this.lock
    if (existsSync(paths.socket)) unlinkSync(paths.socket)
    if (existsSync(paths.session)) unlinkSync(paths.session)
    this.server = createServer((socket) => this.handleSocket(socket))
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      const onError = (error: Error) => reject(error)
      server.once("error", onError)
      server.listen(paths.socket, () => {
        server.off("error", onError)
        resolve()
      })
    })
    chmodSync(paths.socket, 0o600)
    this.metadata = {
      schema_version: 1,
      document: this.service.path,
      socket: paths.socket,
      pid: process.pid,
      token: this.lock.token,
    }
    writeFileSync(paths.session, JSON.stringify(this.metadata), { mode: 0o600 })
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    const { paths } = this.lock
    if (existsSync(paths.session)) unlinkSync(paths.session)
    if (existsSync(paths.socket)) unlinkSync(paths.socket)
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding("utf8")
    let input = ""
    let handled = false
    socket.on("data", (chunk: string) => {
      if (handled) return
      input += chunk
      const newline = input.indexOf("\n")
      if (newline === -1) return
      handled = true
      void this.dispatch(socket, input.slice(0, newline))
    })
    socket.on("close", () => this.sockets.delete(socket))
    socket.on("error", () => this.sockets.delete(socket))
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    try {
      const wire = JSON.parse(line) as WireRequest
      if (!this.metadata || wire.token !== this.metadata.token) {
        throw new DomainError("bad_request", "Session authentication failed")
      }
      if (wire.request.kind === "watch") {
        const after = wire.request.afterRevision
        if (!after || after !== this.service.model.revision) socket.write(`${JSON.stringify(this.service.currentEvent())}\n`)
        const unsubscribe = this.service.subscribe((event) => socket.write(`${JSON.stringify(event)}\n`))
        socket.once("close", unsubscribe)
        return
      }
      const data = await this.service.request(wire.request)
      socket.end(`${JSON.stringify(success(data))}\n`)
    } catch (error) {
      socket.end(`${JSON.stringify(failure(error))}\n`)
    }
  }
}

export async function requestSession<T>(metadata: SessionMetadata, request: ServiceRequest): Promise<Envelope<T>> {
  return await new Promise<Envelope<T>>((resolve, reject) => {
    const socket = createConnection(metadata.socket)
    socket.setEncoding("utf8")
    let output = ""
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: metadata.token, request })}\n`))
    socket.on("data", (chunk: string) => {
      output += chunk
      const newline = output.indexOf("\n")
      if (newline === -1) return
      socket.end()
      try {
        resolve(JSON.parse(output.slice(0, newline)) as Envelope<T>)
      } catch (error) {
        reject(error)
      }
    })
    socket.on("error", reject)
    socket.on("end", () => {
      if (!output.includes("\n")) reject(new Error("Session closed without a response"))
    })
  })
}

export function watchSession(
  metadata: SessionMetadata,
  request: Extract<ServiceRequest, { kind: "watch" }>,
  onLine: (line: string) => void,
): Socket {
  const socket = createConnection(metadata.socket)
  socket.setEncoding("utf8")
  let output = ""
  socket.on("connect", () => socket.write(`${JSON.stringify({ token: metadata.token, request })}\n`))
  socket.on("data", (chunk: string) => {
    output += chunk
    while (true) {
      const newline = output.indexOf("\n")
      if (newline === -1) break
      onLine(output.slice(0, newline))
      output = output.slice(newline + 1)
    }
  })
  return socket
}

export function activeSession(metadataPath: string): SessionMetadata | null {
  return readSessionMetadata(metadataPath)
}
