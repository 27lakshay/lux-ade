import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseSessionEntries } from '@oh-my-pi/pi-coding-agent/session/session-loader'
import { projectHistory } from './history.mjs'

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
