// The send journal keeps only prompts the profile daemon has not admitted, plus
// the restore-held records the transfer bundle reconciles. Once `draft.send.prepare`
// (or `draft.send.get`) proves the daemon holds an intent, the daemon owns it and
// the record leaves the journal. Storage is the client outbox over whatever
// `OutboxStorage` the client gives it (a file for Electron main and the CLI).
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, lstat, unlink, link } from 'node:fs/promises'
import { dirname, isAbsolute, join, basename } from 'node:path'
import { Outbox, type OutboxCodec, type OutboxStorage } from './outbox.js'

/** `pending_sends_exported`: the export's summary. */
export type SendJournalExport = {
  type: 'pending_sends_exported'
  file: string
  format: 'ade-send-journal-bundle-v1'
  source_profile_id: string
  record_count: number
  scope: 'profile-pending-sends-only'
  excluded: string[]
}

/** `pending_sends_imported_held`: the import's summary. Imported prompts stay held. */
export type SendJournalImport = {
  type: 'pending_sends_imported_held'
  source_profile_id: string
  profile_id: string
  record_count: number
  reconciled_count: number
  replay: 'held-until-cross-owner-reconciliation'
}

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
}

type TransferBundle = {
  format: 'ade-send-journal-bundle-v1'
  scope: 'profile-pending-sends-only'
  sourceProfileId: string
  capturedAt: string
  records: { bytes: number; sha256: string; value: SendJournalRecord[] }
  excluded: string[]
}
const bundleExcluded = ['daemon durable send intents', 'provider dispatch outcomes', 'cross-owner replay authority']

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
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
  return Object.entries(value).every(
    ([key, item]) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && jsonValue(item, depth + 1),
  )
}

function validIdentity(value: unknown): value is SendJournalIdentity {
  if (!plainObject(value)) return false
  return ['profileId', 'windowId', 'conversationId', 'requestId'].every(
    (field) => typeof value[field] === 'string' && idPattern.test(value[field]),
  )
}

function validRecord(value: unknown): value is SendJournalRecord {
  if (!validIdentity(value) || !plainObject(value)) return false
  const candidate: Record<string, unknown> = value
  const fields = [
    'attachments',
    'conversationId',
    'dispatchStarted',
    'draftRevision',
    'draftText',
    'endpoint',
    'profileId',
    'requestId',
    'text',
    'windowId',
  ]
  const optional = ['restoreHold'].filter((field) => Object.hasOwn(candidate, field))
  if (!hasFields(candidate, [...fields, ...optional])) return false
  if (candidate.restoreHold !== undefined && candidate.restoreHold !== true) return false
  if (
    typeof candidate.endpoint !== 'string' ||
    !isAbsolute(candidate.endpoint) ||
    candidate.endpoint.includes('\0') ||
    candidate.endpoint.length > 4096
  )
    return false
  if (
    typeof candidate.text !== 'string' ||
    !candidate.text.trim() ||
    Buffer.byteLength(candidate.text) > maxPromptBytes
  )
    return false
  if (typeof candidate.draftText !== 'string' || Buffer.byteLength(candidate.draftText) > maxPromptBytes) return false
  if (!Number.isSafeInteger(candidate.draftRevision) || (candidate.draftRevision as number) < 0) return false
  if (
    !Array.isArray(candidate.attachments) ||
    !jsonValue(candidate.attachments) ||
    Buffer.byteLength(JSON.stringify(candidate.attachments)) > maxAttachmentsBytes
  )
    return false
  return typeof candidate.dispatchStarted === 'boolean'
}

function recordKey(value: Pick<SendJournalRecord, 'profileId' | 'windowId' | 'conversationId'>): string {
  return JSON.stringify([value.profileId, value.windowId, value.conversationId])
}

function copyRecord(record: SendJournalRecord): SendJournalRecord {
  return structuredClone(record)
}

const codec: OutboxCodec<SendJournalRecord> = {
  version,
  name: 'Send recovery journal',
  maxRecords,
  key: recordKey,
  decode(parsed: unknown): SendJournalRecord[] {
    if (
      !plainObject(parsed) ||
      !hasFields(parsed, ['records', 'version']) ||
      parsed.version !== version ||
      !Array.isArray(parsed.records) ||
      parsed.records.length > maxRecords
    ) {
      throw new Error('Send recovery journal has an invalid or unsupported format; preserve the file for recovery')
    }
    for (const value of parsed.records) {
      if (!validRecord(value))
        throw new Error('Send recovery journal contains an invalid record; preserve the file for recovery')
    }
    return parsed.records as SendJournalRecord[]
  },
}
function decodeTransfer(contents: string): TransferBundle {
  let value: unknown
  try {
    value = JSON.parse(contents) as unknown
  } catch {
    throw new Error('Pending-send transfer bundle is invalid')
  }
  if (
    !plainObject(value) ||
    !hasFields(value, ['capturedAt', 'excluded', 'format', 'records', 'scope', 'sourceProfileId']) ||
    value.format !== 'ade-send-journal-bundle-v1' ||
    value.scope !== 'profile-pending-sends-only' ||
    !idPattern.test(String(value.sourceProfileId)) ||
    typeof value.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    JSON.stringify(value.excluded) !== JSON.stringify(bundleExcluded) ||
    !plainObject(value.records) ||
    !hasFields(value.records, ['bytes', 'sha256', 'value'])
  ) {
    throw new Error('Unsupported pending-send transfer bundle')
  }
  const component = value.records
  if (
    !Array.isArray(component.value) ||
    component.value.length > maxRecords ||
    !Number.isSafeInteger(component.bytes) ||
    (component.bytes as number) < 0 ||
    typeof component.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(component.sha256)
  ) {
    throw new Error('Invalid pending-send transfer records')
  }
  const data = JSON.stringify(component.value)
  if (
    Buffer.byteLength(data) !== component.bytes ||
    createHash('sha256').update(data).digest('hex') !== component.sha256
  ) {
    throw new Error('Pending-send transfer records failed verification')
  }
  const records = new Set<string>()
  for (const record of component.value) {
    if (
      !validRecord(record) ||
      record.profileId !== value.sourceProfileId ||
      record.restoreHold ||
      records.has(recordKey(record))
    )
      throw new Error('Invalid or duplicate pending-send transfer record')
    records.add(recordKey(record))
  }
  return value as TransferBundle
}

function matchingIntent(record: SendJournalRecord, response: unknown): boolean {
  if (
    !plainObject(response) ||
    response.type !== 'send_intent' ||
    response.restored_from_backup !== true ||
    !plainObject(response.intent)
  )
    return false
  const intent = response.intent
  return (
    intent.request_id === record.requestId &&
    intent.conversation_id === record.conversationId &&
    intent.window_id === record.windowId &&
    intent.draft_revision === record.draftRevision &&
    intent.draft_text === record.draftText &&
    intent.text === record.text &&
    Array.isArray(intent.attachments) &&
    JSON.stringify(intent.attachments) === JSON.stringify(record.attachments) &&
    (intent.state === 'pending' || intent.state === 'rejected')
  )
}

export class SendJournal {
  /** The journal's name in every refusal, so a person can find its file. */
  static readonly label = codec.name

  private constructor(private readonly outbox: Outbox<SendJournalRecord>) {}

  static async open(storage: OutboxStorage): Promise<SendJournal> {
    return new SendJournal(await Outbox.open(storage, codec))
  }

  // Electron main's pending-send transfer (conversations/ipc.ts) calls this, exportProfile
  // and importProfile; fallow cannot follow calls from another package into a class.
  // fallow-ignore-next-line unused-class-member
  static async inspectTransfer(source: string, expectedSourceProfileId: string): Promise<{ recordCount: number }> {
    const bundle = await this.readTransfer(source, expectedSourceProfileId)
    if (bundle.records.value.some((record) => record.dispatchStarted)) {
      throw new Error('A dispatched prompt has an unknown external outcome; preserve the bundle for reconciliation')
    }
    return { recordCount: bundle.records.value.length }
  }

  private static async readTransfer(source: string, expectedSourceProfileId: string): Promise<TransferBundle> {
    if (
      !isAbsolute(source) ||
      source.includes('\0') ||
      source.length > 4096 ||
      !idPattern.test(expectedSourceProfileId)
    )
      throw new Error('Invalid pending-send transfer source')
    const info = await lstat(source)
    if (!info.isFile() || info.size > maxFileBytes)
      throw new Error('Pending-send transfer must be a bounded regular file')
    const contents = await readFile(source, 'utf8')
    if (Buffer.byteLength(contents) > maxFileBytes) throw new Error('Pending-send transfer is too large')
    const bundle = decodeTransfer(contents)
    if (bundle.sourceProfileId !== expectedSourceProfileId)
      throw new Error('Pending-send source profile identity differs from the backup')
    return bundle
  }

  list(): Promise<SendJournalRecord[]> {
    return this.outbox.list()
  }

  /** A bounded file snapshot only. The profile backup coordinator must still stop source-side sends. */
  // fallow-ignore-next-line unused-class-member
  async exportProfile(profileId: string, destination: string): Promise<SendJournalExport> {
    if (
      !idPattern.test(profileId) ||
      !isAbsolute(destination) ||
      destination.includes('\0') ||
      destination.length > 4096
    ) {
      throw new Error('Invalid pending-send export target')
    }
    const records = (await this.list()).filter((record) => record.profileId === profileId)
    if (records.some((record) => record.restoreHold)) throw new Error('A previously restored prompt is still held')
    const payload = JSON.stringify(records)
    const bundle: TransferBundle = {
      format: 'ade-send-journal-bundle-v1',
      scope: 'profile-pending-sends-only',
      sourceProfileId: profileId,
      capturedAt: new Date().toISOString(),
      records: {
        bytes: Buffer.byteLength(payload),
        sha256: createHash('sha256').update(payload).digest('hex'),
        value: records,
      },
      excluded: bundleExcluded,
    }
    const contents = `${JSON.stringify(bundle)}\n`
    if (Buffer.byteLength(contents) > maxFileBytes) throw new Error('Pending-send transfer exceeds the supported size')
    const directory = dirname(destination)
    const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(contents)
        await file.sync()
      } finally {
        await file.close()
      }
      await link(temporary, destination)
      try {
        const parent = await open(directory, 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      } catch {
        throw new Error(`Pending-send bundle was published at ${destination}, but durability is unconfirmed`)
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return {
      type: 'pending_sends_exported',
      file: destination,
      format: bundle.format,
      source_profile_id: profileId,
      record_count: records.length,
      scope: bundle.scope,
      excluded: bundle.excluded,
    }
  }

  /** Imported records remain held: a copied daemon intent cannot prove the source never dispatched. */
  // fallow-ignore-next-line unused-class-member
  async importProfile(
    source: string,
    expectedSourceProfileId: string,
    targetProfileId: string,
    targetEndpoint: string,
    verifyIntent: (record: SendJournalRecord) => Promise<unknown>,
  ): Promise<SendJournalImport> {
    if (
      !idPattern.test(targetProfileId) ||
      expectedSourceProfileId === targetProfileId ||
      !isAbsolute(targetEndpoint) ||
      targetEndpoint.includes('\0') ||
      targetEndpoint.length > 4096
    )
      throw new Error('Invalid pending-send import target')
    const bundle = await SendJournal.readTransfer(source, expectedSourceProfileId)
    if (bundle.records.value.some((record) => record.dispatchStarted)) {
      throw new Error('A dispatched prompt has an unknown external outcome; preserve the bundle for reconciliation')
    }
    const mapped = bundle.records.value.map((record): SendJournalRecord => ({
      ...copyRecord(record),
      profileId: targetProfileId,
      endpoint: targetEndpoint,
      restoreHold: true,
    }))
    let reconciled = 0
    await this.outbox.mutate(async (records) => {
      const target = [...records.values()].filter((record) => record.profileId === targetProfileId)
      const incoming = new Map(mapped.map((record) => [recordKey(record), record]))
      if (
        target.some((record) => {
          const candidate = incoming.get(recordKey(record))
          return (
            !candidate ||
            !record.restoreHold ||
            record.requestId !== candidate.requestId ||
            record.endpoint !== candidate.endpoint ||
            record.text !== candidate.text ||
            record.draftText !== candidate.draftText ||
            record.draftRevision !== candidate.draftRevision ||
            JSON.stringify(record.attachments) !== JSON.stringify(candidate.attachments)
          )
        })
      ) {
        throw new Error('Target profile has a different or unheld pending prompt; preserve both records')
      }
      for (const record of mapped) {
        let observed: unknown
        try {
          observed = await verifyIntent(copyRecord(record))
        } catch {
          throw new Error('Restored daemon send intent is unavailable; import left the journal unchanged')
        }
        if (!matchingIntent(record, observed)) {
          throw new Error('Restored daemon send intent differs from the journal; import left it unchanged')
        }
      }
      reconciled = target.length
      for (const record of mapped) {
        if (!records.has(recordKey(record))) records.set(recordKey(record), record)
      }
    })
    return {
      type: 'pending_sends_imported_held',
      source_profile_id: expectedSourceProfileId,
      profile_id: targetProfileId,
      record_count: mapped.length,
      reconciled_count: reconciled,
      replay: 'held-until-cross-owner-reconciliation',
    }
  }

  async upsert(record: SendJournalRecord): Promise<void> {
    if (!validRecord(record)) throw new Error('Invalid send recovery record')
    await this.outbox.put(
      record,
      (previous, next) =>
        previous.requestId === next.requestId &&
        previous.endpoint === next.endpoint &&
        previous.text === next.text &&
        previous.draftText === next.draftText &&
        previous.draftRevision === next.draftRevision &&
        JSON.stringify(previous.attachments) === JSON.stringify(next.attachments) &&
        !(previous.dispatchStarted && !next.dispatchStarted) &&
        !(previous.restoreHold && !next.restoreHold),
      'Another prompt or payload owns this send recovery record',
    )
  }

  /**
   * Drops the record for this exact request, once the daemon holds its intent or
   * the prompt is resolved. A missing record, or one for another request, stays as
   * it is. Returns whether a record was removed.
   */
  remove(identity: SendJournalIdentity): Promise<boolean> {
    if (!validIdentity(identity)) throw new Error('Invalid send recovery identity')
    return this.outbox.remove(recordKey(identity), (record) => record.requestId === identity.requestId)
  }
}
