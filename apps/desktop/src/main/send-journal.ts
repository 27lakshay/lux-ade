import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, lstat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

const version = 1
const maxFileBytes = 16 * 1024 * 1024
const maxRecords = 256
const maxPromptBytes = 120 * 1024
const maxAttachmentsBytes = 1024 * 1024
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/

export type SendJournalIdentity = {
  profileId: string
  windowId: string
  conversationId: string
  requestId: string
}

export type SendJournalRecord = SendJournalIdentity & {
  endpoint: string
  text: string
  draftText: string
  draftRevision: number
  attachments: unknown[]
  dispatchStarted: boolean
}

type JournalFile = { version: 1; records: SendJournalRecord[] }

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function hasFields(value: Record<string, unknown>, fields: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === fields.length && actual.every((field, index) => field === fields[index])
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || !jsonValue(value[index], depth + 1)) return false
    }
    return true
  }
  if (!plainObject(value)) return false
  return Object.entries(value).every(([key, item]) =>
    key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && jsonValue(item, depth + 1))
}

function validIdentity(value: unknown): value is SendJournalIdentity {
  if (!plainObject(value)) return false
  return ['profileId', 'windowId', 'conversationId', 'requestId'].every((field) =>
    typeof value[field] === 'string' && idPattern.test(value[field] as string))
}

function validRecord(value: unknown): value is SendJournalRecord {
  if (!validIdentity(value) || !plainObject(value)) return false
  const candidate: Record<string, unknown> = value
  if (!hasFields(candidate, ['attachments', 'conversationId', 'dispatchStarted', 'draftRevision',
    'draftText', 'endpoint', 'profileId', 'requestId', 'text', 'windowId'])) return false
  if (typeof candidate.endpoint !== 'string' || !isAbsolute(candidate.endpoint) || candidate.endpoint.includes('\0') || candidate.endpoint.length > 4096) return false
  if (typeof candidate.text !== 'string' || !candidate.text.trim() || Buffer.byteLength(candidate.text) > maxPromptBytes) return false
  if (typeof candidate.draftText !== 'string' || Buffer.byteLength(candidate.draftText) > maxPromptBytes) return false
  if (!Number.isSafeInteger(candidate.draftRevision) || (candidate.draftRevision as number) < 0) return false
  if (!Array.isArray(candidate.attachments) || !jsonValue(candidate.attachments) ||
    Buffer.byteLength(JSON.stringify(candidate.attachments)) > maxAttachmentsBytes) return false
  return typeof candidate.dispatchStarted === 'boolean'
}

function recordKey(value: Pick<SendJournalRecord, 'profileId' | 'windowId' | 'conversationId'>): string {
  return JSON.stringify([value.profileId, value.windowId, value.conversationId])
}

function copyRecord(record: SendJournalRecord): SendJournalRecord {
  return structuredClone(record)
}

function decodeJournal(contents: string): Map<string, SendJournalRecord> {
  let parsed: unknown
  try { parsed = JSON.parse(contents) }
  catch { throw new Error('Send recovery journal is invalid; preserve the file for recovery') }
  if (!plainObject(parsed) || !hasFields(parsed, ['records', 'version']) || parsed.version !== version ||
    !Array.isArray(parsed.records) || parsed.records.length > maxRecords) {
    throw new Error('Send recovery journal has an invalid or unsupported format; preserve the file for recovery')
  }
  const records = new Map<string, SendJournalRecord>()
  for (const value of parsed.records) {
    if (!validRecord(value)) throw new Error('Send recovery journal contains an invalid record; preserve the file for recovery')
    const key = recordKey(value)
    if (records.has(key)) throw new Error('Send recovery journal contains duplicate owners; preserve the file for recovery')
    records.set(key, copyRecord(value))
  }
  return records
}

export class SendJournal {
  private records: Map<string, SendJournalRecord>
  private tail: Promise<void> = Promise.resolve()
  private unsafe = false

  private constructor(private readonly filePath: string, records: Map<string, SendJournalRecord>) {
    this.records = records
  }

  static async open(filePath: string): Promise<SendJournal> {
    if (!isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Send recovery journal path must be absolute')
    let contents: string
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.size > maxFileBytes) throw new Error('Send recovery journal is invalid or too large; preserve the file for recovery')
      contents = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new SendJournal(filePath, new Map())
      throw error
    }
    if (Buffer.byteLength(contents) > maxFileBytes) throw new Error('Send recovery journal is too large; preserve the file for recovery')
    return new SendJournal(filePath, decodeJournal(contents))
  }

  async list(): Promise<SendJournalRecord[]> {
    await this.tail
    if (this.unsafe) throw new Error('Send recovery journal persistence is uncertain; preserve the file for recovery')
    return [...this.records.values()].map(copyRecord)
  }

  async upsert(record: SendJournalRecord): Promise<void> {
    if (!validRecord(record)) throw new Error('Invalid send recovery record')
    const next = copyRecord(record)
    return this.mutate(async (records) => {
      const key = recordKey(next)
      const previous = records.get(key)
      if (previous && (previous.requestId !== next.requestId || previous.endpoint !== next.endpoint ||
        previous.text !== next.text || previous.draftText !== next.draftText ||
        previous.draftRevision !== next.draftRevision ||
        JSON.stringify(previous.attachments) !== JSON.stringify(next.attachments) ||
        (previous.dispatchStarted && !next.dispatchStarted))) {
        throw new Error('Another prompt or payload owns this send recovery record')
      }
      records.set(key, next)
    })
  }

  async markDispatched(identity: SendJournalIdentity): Promise<void> {
    if (!validIdentity(identity)) throw new Error('Invalid send recovery identity')
    return this.mutate(async (records) => {
      const key = recordKey(identity)
      const record = records.get(key)
      if (!record || record.requestId !== identity.requestId) throw new Error('Send recovery record changed before dispatch')
      records.set(key, { ...record, dispatchStarted: true })
    })
  }

  async remove(identity: SendJournalIdentity): Promise<void> {
    if (!validIdentity(identity)) throw new Error('Invalid send recovery identity')
    return this.mutate(async (records) => {
      const key = recordKey(identity)
      const record = records.get(key)
      if (!record || record.requestId !== identity.requestId) throw new Error('Send recovery record changed before removal')
      records.delete(key)
    })
  }

  private mutate(change: (records: Map<string, SendJournalRecord>) => Promise<void>): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.unsafe) throw new Error('Send recovery journal persistence is uncertain; preserve the file for recovery')
      const next = new Map(this.records)
      await change(next)
      if (next.size > maxRecords) throw new Error('Send recovery journal is full')
      await this.persist(next)
      this.records = next
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  private async persist(records: Map<string, SendJournalRecord>): Promise<void> {
    const directory = dirname(this.filePath)
    const data = JSON.stringify({ version, records: [...records.values()] } satisfies JournalFile)
    if (Buffer.byteLength(data) > maxFileBytes) throw new Error('Send recovery journal is full')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let renamed = false
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(data)
        await file.sync()
      } finally { await file.close() }
      await rename(temporary, this.filePath)
      renamed = true
      const parent = await open(directory, 'r')
      try { await parent.sync() }
      finally { await parent.close() }
    } catch (error) {
      if (renamed) this.unsafe = true
      else await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
