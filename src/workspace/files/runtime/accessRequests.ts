import { randomUUID } from 'node:crypto'
import { RpcError } from '@kernel/rpc/contract'
import type { FileAccessRequest } from '../contract'

const REQUEST_TIMEOUT_MS = 120_000

interface PendingRequest {
  request: FileAccessRequest
  key: string
  timer: ReturnType<typeof setTimeout>
  resolve: Array<(allow: boolean) => void>
}

/** Routes runtime file-access requests to one connected client UI at a time. */
export class FileAccessRequests {
  private readonly subscribers = new Map<number, Set<(request: FileAccessRequest) => void>>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly byKey = new Map<string, PendingRequest>()
  private activeConnectionId: number | null = null

  request(input: Omit<FileAccessRequest, 'id'>): Promise<boolean> {
    const key = `${input.operation}\0${input.path}\0${input.grantPath}`
    const existing = this.byKey.get(key)
    if (existing) {
      return new Promise((resolve) => {
        existing.resolve.push(resolve)
      })
    }

    let resolve!: (allow: boolean) => void
    const result = new Promise<boolean>((done) => { resolve = done })
    const request: FileAccessRequest = { ...input, id: randomUUID() }
    const pending: PendingRequest = {
      request,
      key,
      resolve: [resolve],
      timer: setTimeout(() => this.finish(pending, false), REQUEST_TIMEOUT_MS),
    }
    this.pending.set(request.id, pending)
    this.byKey.set(key, pending)
    this.emit(request)
    return result
  }

  subscribe(connectionId: number, emit: (request: FileAccessRequest) => void): () => void {
    let connectionSubscribers = this.subscribers.get(connectionId)
    if (!connectionSubscribers) {
      connectionSubscribers = new Set()
      this.subscribers.set(connectionId, connectionSubscribers)
    }
    connectionSubscribers.add(emit)
    if (this.activeConnectionId === null) {
      this.activeConnectionId = connectionId
      for (const pending of this.pending.values()) this.emit(pending.request)
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      const subscribers = this.subscribers.get(connectionId)
      if (!subscribers) return
      subscribers.delete(emit)
      if (subscribers.size > 0) return
      this.subscribers.delete(connectionId)
      if (this.activeConnectionId !== connectionId) return
      this.activeConnectionId = this.subscribers.keys().next().value ?? null
      if (this.activeConnectionId !== null) {
        for (const pending of this.pending.values()) this.emit(pending.request)
      }
    }
  }

  resolve(connectionId: number, requestId: string, allow: boolean): void {
    if (this.activeConnectionId !== connectionId) {
      throw new RpcError('rejected', 'This client cannot answer the file-access request')
    }
    const pending = this.pending.get(requestId)
    if (!pending) throw new RpcError('gone', 'The file-access request has expired')
    this.finish(pending, allow)
  }

  dispose(): void {
    for (const pending of this.pending.values()) this.finish(pending, false)
    this.subscribers.clear()
    this.activeConnectionId = null
  }

  private emit(request: FileAccessRequest): void {
    if (this.activeConnectionId === null) return
    const subscriber = this.subscribers.get(this.activeConnectionId)?.values().next().value
    try { subscriber?.(request) } catch { /* a closed client will unsubscribe */ }
  }

  private finish(pending: PendingRequest, allow: boolean): void {
    if (!this.pending.delete(pending.request.id)) return
    clearTimeout(pending.timer)
    this.byKey.delete(pending.key)
    for (const resolve of pending.resolve) resolve(allow)
  }
}
