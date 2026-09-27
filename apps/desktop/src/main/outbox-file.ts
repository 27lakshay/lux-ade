// The file-backed storage Electron main gives the client outbox. Each save writes a
// private temporary file, syncs it, renames it over the target and syncs the
// directory. A failure after the rename is reported as uncertain, because the new
// file may or may not survive a crash.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { OutboxPersistenceUncertain, type OutboxFile, type OutboxStorage } from '@ade/client/outbox'

const maxBytes = 16 * 1024 * 1024

export function fileOutboxStorage(file: string, name: string): OutboxStorage {
  if (!isAbsolute(file) || file.includes('\0')) throw new Error(`${name} path must be absolute`)
  return {
    async load(): Promise<unknown> {
      let raw: string
      try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > maxBytes)
            throw new Error(`${name} is invalid or too large; preserve the file for recovery`)
          raw = await handle.readFile('utf8')
        } finally {
          await handle.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      if (Buffer.byteLength(raw) > maxBytes) throw new Error(`${name} is too large; preserve the file for recovery`)
      try {
        return JSON.parse(raw) as unknown
      } catch {
        throw new Error(`${name} is invalid; preserve the file for recovery`)
      }
    },
    async save(value: OutboxFile<unknown>): Promise<void> {
      const payload = JSON.stringify(value)
      if (Buffer.byteLength(payload) > maxBytes) throw new Error(`${name} is full`)
      const directory = dirname(file)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      let renamed = false
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(payload)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, file)
        renamed = true
        const parent = await open(directory, 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      } catch (error) {
        if (renamed)
          throw new OutboxPersistenceUncertain(`${name} was replaced, but its durability is unconfirmed`, {
            cause: error,
          })
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    },
  }
}
