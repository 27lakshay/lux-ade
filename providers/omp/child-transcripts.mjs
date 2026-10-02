import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseSessionEntries } from '@oh-my-pi/pi-coding-agent/session/session-loader'
import { projectHistory } from './history.mjs'

export class ChildTranscripts {
  constructor(db) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS child_transcripts (
      parent TEXT NOT NULL, child TEXT NOT NULL, file TEXT NOT NULL, header_id TEXT,
      PRIMARY KEY(parent, child)
    )`)
  }
  remember(parent, payload) {
    if (!payload?.sessionFile) return
    if (
      typeof payload.id !== 'string' ||
      !payload.id ||
      Buffer.byteLength(payload.id) > 4096 ||
      typeof payload.sessionFile !== 'string' ||
      !isAbsolute(payload.sessionFile) ||
      Buffer.byteLength(payload.sessionFile) > 4096
    )
      throw new Error('Invalid Oh My Pi child transcript identity')
    const existing = this.db
      .query('SELECT file FROM child_transcripts WHERE parent=? AND child=?')
      .get(parent, payload.id)
    if (existing && existing.file !== payload.sessionFile) throw new Error('Oh My Pi child transcript path changed')
    this.db
      .query('INSERT OR IGNORE INTO child_transcripts(parent,child,file) VALUES (?,?,?)')
      .run(parent, payload.id, payload.sessionFile)
  }
  async read(parent, child, offset) {
    const record = this.db
      .query('SELECT file,header_id FROM child_transcripts WHERE parent=? AND child=?')
      .get(parent, child)
    if (!record) throw new Error('Child transcript was not announced by this Oh My Pi session')
    const result = await readChildTranscript(record.file, child, offset, record.header_id)
    this.db
      .query('UPDATE child_transcripts SET header_id=? WHERE parent=? AND child=? AND header_id IS NULL')
      .run(result.header_id, parent, child)
    return result.page
  }
}

// The public worker keeps this native reference only in its session-local map.
export async function readChildTranscript(file, child, offset, expectedHeaderId = null) {
  if (
    typeof child !== 'string' ||
    !child ||
    Buffer.byteLength(child) > 4096 ||
    typeof file !== 'string' ||
    !isAbsolute(file) ||
    Buffer.byteLength(file) > 4096 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new Error('Invalid Oh My Pi child transcript identity')
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  let bytes
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error('Oh My Pi child transcript exceeds reader limits')
    const buffer = Buffer.alloc(info.size)
    let count = 0
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    bytes = buffer.subarray(0, count)
  } finally {
    await handle.close()
  }
  // An active writer may leave an incomplete final record. Only complete
  // JSONL records enter the provider's parser and ancestry projection.
  const end = bytes.lastIndexOf(10)
  if (end < 0) throw new Error('Oh My Pi child transcript is not ready')
  const records = parseSessionEntries(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end + 1)))
  const header = records.find((entry) => entry.type === 'session')
  if (!header?.id || (expectedHeaderId && expectedHeaderId !== header.id))
    throw new Error('Oh My Pi child transcript identity changed')
  const entries = records.filter((entry) => typeof entry.id === 'string' && Object.hasOwn(entry, 'parentId'))
  if (entries.length > 50000) throw new Error('Oh My Pi child transcript exceeds entry limits')
  const projection = projectHistory({ entries, leafId: entries.at(-1)?.id ?? null })
  const items = projection.items.slice(offset, offset + 50)
  if (Buffer.byteLength(JSON.stringify(items)) > 2 * 1024 * 1024)
    throw new Error('Oh My Pi child page exceeds display limits')
  return {
    header_id: header.id,
    page: {
      type: 'child_transcript',
      child_id: child,
      items,
      next_offset: projection.items.length > offset + 50 ? offset + 50 : null,
    },
  }
}
