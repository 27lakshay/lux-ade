import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, lstat, unlink, link } from 'node:fs/promises'
import { dirname, isAbsolute, join, basename } from 'node:path'

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
  restoreHold?: true
  reviewAnchor?: { workspace_id: string; path: string; staged: boolean; revision: string;
    token: string; hunk: string; line: number; text: string }
  reviewFeedback?: { format: 'ade-review-feedback-v1'; workspace_id: string; notes: {
    anchor: { workspace_id: string; path: string; staged: boolean; revision: string;
      token: string; hunk: string; line: number; text: string; end_line?: number; end_text?: string };
    note: string }[] }
}

type JournalFile = { version: 1; records: SendJournalRecord[] }
type TransferBundle = { format: 'ade-send-journal-bundle-v1'; scope: 'profile-pending-sends-only';
  sourceProfileId: string; capturedAt: string; records: { bytes: number; sha256: string; value: SendJournalRecord[] };
  excluded: string[] }
const bundleExcluded = ['daemon durable send intents', 'provider dispatch outcomes', 'cross-owner replay authority']

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function hasFields(value: Record<string, unknown>, fields: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
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
  const fields = ['attachments', 'conversationId', 'dispatchStarted', 'draftRevision',
    'draftText', 'endpoint', 'profileId', 'requestId', 'text', 'windowId']
  const optional = ['restoreHold', 'reviewAnchor', 'reviewFeedback'].filter((field) => Object.hasOwn(candidate, field))
  if (!hasFields(candidate, [...fields, ...optional])) return false
  if (candidate.restoreHold !== undefined && candidate.restoreHold !== true) return false
  if (candidate.reviewAnchor !== undefined) {
    const anchor = candidate.reviewAnchor
    if (!plainObject(anchor) || !hasFields(anchor, ['workspace_id', 'path', 'staged', 'revision', 'token', 'hunk', 'line', 'text']) ||
      typeof anchor.workspace_id !== 'string' || !idPattern.test(anchor.workspace_id) ||
      typeof anchor.path !== 'string' || !anchor.path || anchor.path.length > 4096 ||
      typeof anchor.staged !== 'boolean' || typeof anchor.revision !== 'string' ||
      typeof anchor.token !== 'string' || typeof anchor.hunk !== 'string' ||
      !Number.isSafeInteger(anchor.line) || typeof anchor.text !== 'string' ||
      Buffer.byteLength(JSON.stringify(anchor)) > 12 * 1024) return false
  }
  if (candidate.reviewFeedback !== undefined) {
    const feedback = candidate.reviewFeedback
    if (!plainObject(feedback) || !hasFields(feedback, ['format', 'workspace_id', 'notes']) ||
      feedback.format !== 'ade-review-feedback-v1' ||
      typeof feedback.workspace_id !== 'string' || !idPattern.test(feedback.workspace_id) ||
      !Array.isArray(feedback.notes) || feedback.notes.length < 1 || feedback.notes.length > 16 ||
      Buffer.byteLength(JSON.stringify(feedback)) > 64 * 1024 ||
      !feedback.notes.every((item) => {
        if (!plainObject(item) || !hasFields(item, ['anchor', 'note']) ||
          typeof item.note !== 'string' || !item.note.trim() || Buffer.byteLength(item.note) > 4096 ||
          !plainObject(item.anchor)) return false
        const anchor = item.anchor
        const range = Object.hasOwn(anchor, 'end_line') || Object.hasOwn(anchor, 'end_text')
        return hasFields(anchor, range ? ['workspace_id', 'path', 'staged', 'revision', 'token', 'hunk', 'line', 'text', 'end_line', 'end_text'] :
          ['workspace_id', 'path', 'staged', 'revision', 'token', 'hunk', 'line', 'text']) &&
          anchor.workspace_id === feedback.workspace_id && typeof anchor.path === 'string' &&
          anchor.path.length > 0 && anchor.path.length <= 4096 && typeof anchor.staged === 'boolean' &&
          typeof anchor.revision === 'string' && typeof anchor.token === 'string' &&
          typeof anchor.hunk === 'string' && Number.isSafeInteger(anchor.line) &&
          typeof anchor.text === 'string' && (!range ||
            Number.isSafeInteger(anchor.end_line) && typeof anchor.end_text === 'string')
      }) || candidate.reviewAnchor !== undefined) return false
  }
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
function decodeTransfer(contents: string): TransferBundle {
  let value: unknown
  try { value = JSON.parse(contents) as unknown }
  catch { throw new Error('Pending-send transfer bundle is invalid') }
  if (!plainObject(value) || !hasFields(value, ['capturedAt', 'excluded', 'format', 'records', 'scope', 'sourceProfileId']) ||
    value.format !== 'ade-send-journal-bundle-v1' || value.scope !== 'profile-pending-sends-only' ||
    !idPattern.test(String(value.sourceProfileId)) || typeof value.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.capturedAt)) || JSON.stringify(value.excluded) !== JSON.stringify(bundleExcluded) ||
    !plainObject(value.records) || !hasFields(value.records, ['bytes', 'sha256', 'value'])) {
    throw new Error('Unsupported pending-send transfer bundle')
  }
  const component = value.records
  if (!Array.isArray(component.value) || component.value.length > maxRecords ||
    !Number.isSafeInteger(component.bytes) || (component.bytes as number) < 0 ||
    typeof component.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(component.sha256)) {
    throw new Error('Invalid pending-send transfer records')
  }
  const data = JSON.stringify(component.value)
  if (Buffer.byteLength(data) !== component.bytes ||
    createHash('sha256').update(data).digest('hex') !== component.sha256) {
    throw new Error('Pending-send transfer records failed verification')
  }
  const records = new Set<string>()
  for (const record of component.value) {
    if (!validRecord(record) || record.profileId !== value.sourceProfileId || record.restoreHold ||
      records.has(recordKey(record))) throw new Error('Invalid or duplicate pending-send transfer record')
    records.add(recordKey(record))
  }
  return value as TransferBundle
}

function matchingIntent(record: SendJournalRecord, response: unknown): boolean {
  if (!plainObject(response) || response.type !== 'send_intent' ||
    response.restored_from_backup !== true || !plainObject(response.intent)) return false
  const intent = response.intent
  const reviewAnchor = intent.review_anchor
  const reviewFeedback = intent.review_feedback
  const canonical = (value: unknown): string => JSON.stringify(value ?? null, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  return intent.request_id === record.requestId && intent.conversation_id === record.conversationId &&
    intent.window_id === record.windowId && intent.draft_revision === record.draftRevision &&
    intent.draft_text === record.draftText && intent.text === record.text &&
    (reviewAnchor == null && record.reviewAnchor == null ||
      plainObject(reviewAnchor) && record.reviewAnchor !== undefined &&
      ['workspace_id', 'path', 'staged', 'revision', 'token', 'hunk', 'line', 'text'].every((field) =>
        reviewAnchor[field] === record.reviewAnchor?.[field as keyof typeof record.reviewAnchor])) &&
    canonical(reviewFeedback) === canonical(record.reviewFeedback) &&
    Array.isArray(intent.attachments) && JSON.stringify(intent.attachments) === JSON.stringify(record.attachments) &&
    (intent.state === 'pending' || intent.state === 'rejected')
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

  static async inspectTransfer(source: string, expectedSourceProfileId: string): Promise<{ recordCount: number }> {
    const bundle = await this.readTransfer(source, expectedSourceProfileId)
    if (bundle.records.value.some((record) => record.dispatchStarted)) {
      throw new Error('A dispatched prompt has an unknown external outcome; preserve the bundle for reconciliation')
    }
    return { recordCount: bundle.records.value.length }
  }

  private static async readTransfer(source: string, expectedSourceProfileId: string): Promise<TransferBundle> {
    if (!isAbsolute(source) || source.includes('\0') || source.length > 4096 ||
      !idPattern.test(expectedSourceProfileId)) throw new Error('Invalid pending-send transfer source')
    const info = await lstat(source)
    if (!info.isFile() || info.size > maxFileBytes) throw new Error('Pending-send transfer must be a bounded regular file')
    const contents = await readFile(source, 'utf8')
    if (Buffer.byteLength(contents) > maxFileBytes) throw new Error('Pending-send transfer is too large')
    const bundle = decodeTransfer(contents)
    if (bundle.sourceProfileId !== expectedSourceProfileId) throw new Error('Pending-send source profile identity differs from the backup')
    return bundle
  }

  async list(): Promise<SendJournalRecord[]> {
    await this.tail
    if (this.unsafe) throw new Error('Send recovery journal persistence is uncertain; preserve the file for recovery')
    return [...this.records.values()].map(copyRecord)
  }

  /** A bounded file snapshot only. The profile backup coordinator must still stop source-side sends. */
  async exportProfile(profileId: string, destination: string): Promise<Record<string, unknown>> {
    if (!idPattern.test(profileId) || !isAbsolute(destination) || destination.includes('\0') || destination.length > 4096) {
      throw new Error('Invalid pending-send export target')
    }
    const records = (await this.list()).filter((record) => record.profileId === profileId)
    if (records.some((record) => record.restoreHold)) throw new Error('A previously restored prompt is still held')
    const payload = JSON.stringify(records)
    const bundle: TransferBundle = { format: 'ade-send-journal-bundle-v1', scope: 'profile-pending-sends-only',
      sourceProfileId: profileId, capturedAt: new Date().toISOString(),
      records: { bytes: Buffer.byteLength(payload), sha256: createHash('sha256').update(payload).digest('hex'), value: records },
      excluded: bundleExcluded }
    const contents = `${JSON.stringify(bundle)}\n`
    if (Buffer.byteLength(contents) > maxFileBytes) throw new Error('Pending-send transfer exceeds the supported size')
    const directory = dirname(destination)
    const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(contents); await file.sync() }
      finally { await file.close() }
      await link(temporary, destination)
      try {
        const parent = await open(directory, 'r')
        try { await parent.sync() } finally { await parent.close() }
      } catch { throw new Error(`Pending-send bundle was published at ${destination}, but durability is unconfirmed`) }
    } finally { await unlink(temporary).catch(() => undefined) }
    return { type: 'pending_sends_exported', file: destination, format: bundle.format,
      source_profile_id: profileId, record_count: records.length, scope: bundle.scope, excluded: bundle.excluded }
  }

  /** Imported records remain held: a copied daemon intent cannot prove the source never dispatched. */
  async importProfile(source: string, expectedSourceProfileId: string, targetProfileId: string,
    targetEndpoint: string, verifyIntent: (record: SendJournalRecord) => Promise<unknown>): Promise<Record<string, unknown>> {
    if (!idPattern.test(targetProfileId) ||
      expectedSourceProfileId === targetProfileId || !isAbsolute(targetEndpoint) ||
      targetEndpoint.includes('\0') || targetEndpoint.length > 4096) throw new Error('Invalid pending-send import target')
    const bundle = await SendJournal.readTransfer(source, expectedSourceProfileId)
    if (bundle.records.value.some((record) => record.dispatchStarted)) {
      throw new Error('A dispatched prompt has an unknown external outcome; preserve the bundle for reconciliation')
    }
    const mapped = bundle.records.value.map((record): SendJournalRecord => ({ ...copyRecord(record),
      profileId: targetProfileId, endpoint: targetEndpoint, restoreHold: true }))
    let reconciled = 0
    await this.mutate(async (records) => {
      const target = [...records.values()].filter((record) => record.profileId === targetProfileId)
      const incoming = new Map(mapped.map((record) => [recordKey(record), record]))
      if (target.some((record) => {
        const candidate = incoming.get(recordKey(record))
        return !candidate || !record.restoreHold || record.requestId !== candidate.requestId ||
          record.endpoint !== candidate.endpoint || record.text !== candidate.text ||
          record.draftText !== candidate.draftText || record.draftRevision !== candidate.draftRevision ||
          JSON.stringify(record.attachments) !== JSON.stringify(candidate.attachments)
      })) {
        throw new Error('Target profile has a different or unheld pending prompt; preserve both records')
      }
      for (const record of mapped) {
        let observed: unknown
        try { observed = await verifyIntent(copyRecord(record)) }
        catch { throw new Error('Restored daemon send intent is unavailable; import left the journal unchanged') }
        if (!matchingIntent(record, observed)) {
          throw new Error('Restored daemon send intent differs from the journal; import left it unchanged')
        }
      }
      reconciled = target.length
      for (const record of mapped) {
        if (!records.has(recordKey(record))) records.set(recordKey(record), record)
      }
    })
    return { type: 'pending_sends_imported_held', source_profile_id: expectedSourceProfileId,
      profile_id: targetProfileId, record_count: mapped.length, reconciled_count: reconciled,
      replay: 'held-until-cross-owner-reconciliation' }
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
        (previous.dispatchStarted && !next.dispatchStarted) || (previous.restoreHold && !next.restoreHold))) {
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
      if (record.restoreHold) throw new Error('Restored prompt is held until its source outcome is reconciled')
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
