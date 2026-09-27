// The client outbox: durable records of operations the profile daemon has not yet
// admitted. Once the daemon admits an operation it owns the rest of its life
// (`draft.send.list` and `draft.send.acknowledge` for sends, `review.operation.list`
// and `review.operation.acknowledge` for Git mutations), so a record leaves the
// outbox as soon as admission is proven.
//
// This module is transport-free and imports nothing from Node, so any client can
// use it through `@ade/client/outbox`. The caller supplies the storage: Electron
// main persists a file; a test can keep it in memory.
import type { PendingSend, ReviewOperationEntry, SendOutcome } from '@ade/contracts'

/** What an outbox file holds. `version` belongs to the caller's codec. */
export type OutboxFile<R> = { version: number; records: R[] }

/**
 * Where an outbox keeps its records. `load` returns `undefined` when nothing was
 * ever saved. `save` must replace the stored value atomically. It throws
 * `OutboxPersistenceUncertain` when the new value may or may not be durable; any
 * other error must mean the previous value is still the stored one.
 */
export interface OutboxStorage {
  load(): Promise<unknown>
  save(value: OutboxFile<unknown>): Promise<void>
}

/** A save whose durability cannot be proven either way. The outbox then refuses all use. */
export class OutboxPersistenceUncertain extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OutboxPersistenceUncertain'
  }
}

/** How one kind of record is stored and keyed. */
export type OutboxCodec<R> = {
  /** The version written on save. */
  version: number
  /** Decodes a stored value, including older versions it still reads. Throws when invalid. */
  decode(value: unknown): R[]
  /** The owner key. The outbox holds at most one record per key. */
  key(record: R): string
  maxRecords: number
  /** The message used for every refusal, so callers can name their file. */
  name: string
}

/**
 * A small durable map of unadmitted operations. Mutations run one at a time, and
 * each one reaches storage before memory changes. After an uncertain save the
 * outbox refuses every call, so the caller preserves the file for recovery
 * instead of acting on state it cannot prove.
 */
export class Outbox<R> {
  private records: Map<string, R>
  private tail: Promise<void> = Promise.resolve()
  private unsafe = false

  private constructor(private readonly storage: OutboxStorage, private readonly codec: OutboxCodec<R>,
    records: Map<string, R>) {
    this.records = records
  }

  static async open<R>(storage: OutboxStorage, codec: OutboxCodec<R>): Promise<Outbox<R>> {
    const stored = await storage.load()
    const records = new Map<string, R>()
    if (stored !== undefined) {
      const decoded = codec.decode(stored)
      if (decoded.length > codec.maxRecords) throw new Error(`${codec.name} is full; preserve it for recovery`)
      for (const record of decoded) {
        const key = codec.key(record)
        if (records.has(key)) throw new Error(`${codec.name} contains duplicate owners; preserve it for recovery`)
        records.set(key, structuredClone(record))
      }
    }
    return new Outbox(storage, codec, records)
  }

  async list(): Promise<R[]> {
    await this.tail
    this.assertSafe()
    return [...this.records.values()].map((record) => structuredClone(record))
  }

  async get(key: string): Promise<R | null> {
    await this.tail
    this.assertSafe()
    const record = this.records.get(key)
    return record === undefined ? null : structuredClone(record)
  }

  /**
   * Stores `record` under its key. An existing record under the same key must be
   * `compatible` with the new one, or the call is refused with `refusal` and
   * nothing changes.
   */
  put(record: R, compatible: (previous: R, next: R) => boolean,
    refusal = `Another operation owns this ${this.codec.name} record`): Promise<void> {
    const next = structuredClone(record)
    return this.mutate((records) => {
      const key = this.codec.key(next)
      const previous = records.get(key)
      if (previous !== undefined && !compatible(previous, next)) {
        throw new Error(refusal)
      }
      records.set(key, next)
    })
  }

  /** Removes the record under `key` when `matches` accepts it. Returns whether one was removed. */
  async remove(key: string, matches: (record: R) => boolean): Promise<boolean> {
    let removed = false
    await this.mutate((records) => {
      const record = records.get(key)
      if (record === undefined || !matches(record)) return
      records.delete(key)
      removed = true
    })
    return removed
  }

  /**
   * Runs `change` on a copy of the records and saves the result. The copy replaces
   * memory only after storage accepted it. A change that throws leaves both alone.
   */
  mutate(change: (records: Map<string, R>) => void | Promise<void>): Promise<void> {
    const operation = this.tail.then(async () => {
      this.assertSafe()
      const next = new Map([...this.records].map(([key, value]) => [key, structuredClone(value)]))
      const before = JSON.stringify([...next.values()])
      await change(next)
      if (JSON.stringify([...next.values()]) === before) return
      if (next.size > this.codec.maxRecords) throw new Error(`${this.codec.name} is full`)
      try {
        await this.storage.save({ version: this.codec.version, records: [...next.values()] })
      } catch (error) {
        if (error instanceof OutboxPersistenceUncertain) this.unsafe = true
        throw error
      }
      this.records = next
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  private assertSafe(): void {
    if (this.unsafe) throw new Error(`${this.codec.name} persistence is uncertain; preserve it for recovery`)
  }
}

// ---------------------------------------------------------------------------
// Send recovery.

/** The facts about one send that its recovery decision depends on. */
export type SendRecoveryInput = {
  /** A pre-admission outbox record for this owner and Conversation, if any. */
  local: { requestId: string; restoreHold: boolean; admitted: boolean } | null
  /** Whether this client has already seen the daemon hold this intent. */
  admitted: boolean
  /** What `draft.send.list` reports for this owner and Conversation, if anything. */
  daemon: { requestId: string; outcome: SendOutcome; matches: boolean } | null
  requestId: string
}

/**
 * What to do next with one send. `prepare` replays the pre-admission steps with the
 * original request ID: the daemon holds no intent, so nothing can have been
 * dispatched. `deliver` retries `agent.send` with the original ID, which the daemon
 * deduplicates. `acknowledge` settles an accepted or already-settled send;
 * `release` settles a rejected one. Everything else keeps the request ID and waits.
 */
export type SendRecoveryAction =
  | { kind: 'prepare' }
  | { kind: 'deliver' }
  | { kind: 'acknowledge' }
  | { kind: 'release' }
  | { kind: 'hold' }
  | { kind: 'conflict'; reason: string }

export function decideSendRecovery(input: SendRecoveryInput): SendRecoveryAction {
  const { local, daemon } = input
  if (local && local.requestId !== input.requestId) {
    return { kind: 'conflict', reason: 'Another prompt owns the local recovery record' }
  }
  if (local?.restoreHold) return { kind: 'hold' }
  if (daemon) {
    if (daemon.requestId !== input.requestId || !daemon.matches) {
      return { kind: 'conflict', reason: 'A different prompt is awaiting reconciliation for this draft' }
    }
    switch (daemon.outcome) {
      case 'held': return { kind: 'hold' }
      case 'accepted': return { kind: 'acknowledge' }
      case 'rejected': return { kind: 'release' }
      case 'prepared': return { kind: 'deliver' }
      case 'conflict': return { kind: 'conflict', reason: 'The daemon holds an accepted message for a rejected prompt' }
    }
  }
  // The daemon lists no unresolved intent. A record that never reached admission
  // replays its pre-admission steps; anything the daemon once held has settled,
  // and acknowledgement returns that settlement again.
  if (local && !local.admitted && !input.admitted) return { kind: 'prepare' }
  return { kind: 'acknowledge' }
}

/** Finds one Conversation's unresolved send in `draft.send.list` pages. */
export async function findPendingSend(conversationId: string,
  page: (after: string | undefined) => Promise<{ sends: PendingSend[]; next_cursor: string | null }>,
  maxPages = 16): Promise<PendingSend | null> {
  let after: string | undefined
  for (let index = 0; index < maxPages; index++) {
    const reply = await page(after)
    const found = reply.sends.find((send) => send.intent.conversation_id === conversationId)
    if (found) return found
    // Pages are ordered by Conversation ID, so a later page cannot hold an earlier ID.
    const last = reply.sends.at(-1)?.intent.conversation_id
    if (!reply.next_cursor || (last !== undefined && last > conversationId)) return null
    if (after !== undefined && reply.next_cursor <= after) throw new Error('Pending send list did not advance')
    after = reply.next_cursor
  }
  throw new Error('Pending send list is too long to search')
}

// ---------------------------------------------------------------------------
// Git operations.

export type GitAdmission = { kind: 'admit' } | { kind: 'refuse'; reason: string; blocking: string }

/**
 * The one-unacknowledged-Git-operation-per-workspace rule. A new operation is
 * admitted only when neither the local outbox nor the daemon holds another one
 * that still needs the person: a pre-admission record, a running operation, or an
 * interrupted one nobody acknowledged. A retry of the same request passes, but
 * only with the same payload.
 */
export function decideGitAdmission(requestId: string, samePayload: boolean, local: { request_id: string } | null,
  listed: ReviewOperationEntry[]): GitAdmission {
  if (local) {
    if (local.request_id !== requestId) {
      return { kind: 'refuse', reason: 'Another Git operation needs reconciliation in this workspace', blocking: local.request_id }
    }
    if (!samePayload) return { kind: 'refuse', reason: 'Git operation ID belongs to another request', blocking: requestId }
  }
  const other = listed.find((entry) => entry.acknowledged_at === null && entry.operation.id !== requestId)
  if (other) return { kind: 'refuse', reason: 'Another Git operation needs reconciliation in this workspace', blocking: other.operation.id }
  return { kind: 'admit' }
}

/**
 * The Git operation a workspace shows as pending. A local pre-admission record wins,
 * because only it keeps the parameters a retry needs; otherwise the newest daemon
 * operation that still needs the person.
 */
export function pendingGitOperation<L extends { request_id: string }>(local: L | null,
  listed: ReviewOperationEntry[]): { source: 'local'; record: L } | { source: 'daemon'; entry: ReviewOperationEntry } | null {
  if (local) return { source: 'local', record: local }
  const entry = listed.find((item) => item.acknowledged_at === null)
  return entry ? { source: 'daemon', entry } : null
}

/** Whether a local record is proven admitted: the daemon lists its ID. */
export function gitAdmitted(requestId: string, listed: ReviewOperationEntry[]): boolean {
  return listed.some((entry) => entry.operation.id === requestId)
}
