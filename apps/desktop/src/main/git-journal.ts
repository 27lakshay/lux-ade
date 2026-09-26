import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

export type GitIntent = { profile_id: string; workspace_id: string;
  op: 'review.stage' | 'review.unstage' | 'review.commit' | 'review.discard';
  request_id: string; path?: string; revision?: string; diff_token?: string; index_token?: string; message?: string }
export type ArchivedGitIntent = { intent: GitIntent; acknowledged_at: number }
type JournalFile = { version: 1; active: GitIntent[]; archived: ArchivedGitIntent[] }
const id = /^[a-zA-Z0-9_-]{1,128}$/
const uuid = /^[0-9a-f-]{36}$/
const token = /^[0-9a-f]{16}$/
const maxBytes = 16 * 1024 * 1024

function valid(intent: unknown): intent is GitIntent {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return false
  const item = intent as Record<string, unknown>
  if (typeof item.profile_id !== 'string' || !id.test(item.profile_id) ||
    typeof item.workspace_id !== 'string' || !id.test(item.workspace_id) ||
    typeof item.request_id !== 'string' || !uuid.test(item.request_id)) return false
  if (item.op === 'review.commit') return typeof item.message === 'string' && Boolean(item.message.trim()) &&
    Buffer.byteLength(item.message) <= 64 * 1024 && typeof item.index_token === 'string' && token.test(item.index_token) &&
    Object.keys(item).sort().join(',') === 'index_token,message,op,profile_id,request_id,workspace_id'
  if (item.op === 'review.stage' || item.op === 'review.unstage' || item.op === 'review.discard') return typeof item.path === 'string' &&
    item.path.length > 0 && item.path.length <= 4096 && !item.path.includes('\0') &&
    !item.path.startsWith('/') && item.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
    typeof item.revision === 'string' && token.test(item.revision) &&
    (item.op === 'review.discard'
      ? typeof item.diff_token === 'string' && token.test(item.diff_token) &&
        Object.keys(item).sort().join(',') === 'diff_token,op,path,profile_id,request_id,revision,workspace_id'
      : Object.keys(item).sort().join(',') === 'op,path,profile_id,request_id,revision,workspace_id')
  return false
}

function key(intent: Pick<GitIntent, 'profile_id' | 'workspace_id'>): string {
  return JSON.stringify([intent.profile_id, intent.workspace_id])
}

export class GitJournal {
  private active: GitIntent[]
  private archived: ArchivedGitIntent[]
  private tail: Promise<void> = Promise.resolve()
  private unsafe = false

  private constructor(private readonly file: string, data: JournalFile) {
    this.active = data.active
    this.archived = data.archived
  }

  static async open(file: string): Promise<GitJournal> {
    if (!isAbsolute(file)) throw new Error('Git recovery journal path must be absolute')
    let raw: string
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > maxBytes) throw new Error('Git recovery journal is invalid; preserve it for recovery')
        raw = await handle.readFile('utf8')
        if (Buffer.byteLength(raw) > maxBytes) throw new Error('Git recovery journal is too large; preserve it for recovery')
      } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new GitJournal(file, { version: 1, active: [], archived: [] })
      throw error
    }
    let data: unknown
    try { data = JSON.parse(raw) }
    catch { throw new Error('Git recovery journal is corrupt; preserve it for recovery') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Git recovery journal is invalid; preserve it for recovery')
    const value = data as Record<string, unknown>
    if (value.version !== 1 || !Array.isArray(value.active) || !Array.isArray(value.archived) ||
      Object.keys(value).sort().join(',') !== 'active,archived,version' ||
      value.active.some((item) => !valid(item)) ||
      value.archived.some((item) => !item || typeof item !== 'object' || !valid(item.intent) ||
        !Number.isSafeInteger(item.acknowledged_at)) ||
      new Set(value.active.map((item) => key(item))).size !== value.active.length) {
      throw new Error('Git recovery journal is invalid; preserve it for recovery')
    }
    return new GitJournal(file, value as JournalFile)
  }

  async list(profileId: string, workspaceId: string): Promise<{ pending: GitIntent | null; archived: ArchivedGitIntent[] }> {
    await this.tail
    if (this.unsafe) throw new Error('Git recovery journal persistence is uncertain; preserve it for recovery')
    return { pending: this.active.find((item) => item.profile_id === profileId && item.workspace_id === workspaceId) ?? null,
      archived: this.archived.filter((item) => item.intent.profile_id === profileId && item.intent.workspace_id === workspaceId) }
  }

  async prepare(intent: GitIntent): Promise<void> {
    if (!valid(intent)) throw new Error('Invalid Git recovery intent')
    await this.mutate((data) => {
      const existing = data.active.find((item) => key(item) === key(intent))
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error('Another Git operation needs reconciliation in this workspace')
        return false
      }
      if (data.active.some((item) => item.request_id === intent.request_id) ||
        data.archived.some((item) => item.intent.request_id === intent.request_id)) {
        throw new Error('Git operation ID belongs to another request')
      }
      data.active.push(intent)
      return true
    })
  }

  async settle(profileId: string, workspaceId: string, requestId: string): Promise<void> {
    await this.mutate((data) => {
      const index = data.active.findIndex((item) => item.profile_id === profileId && item.workspace_id === workspaceId)
      if (index < 0 || data.active[index].request_id !== requestId) throw new Error('Git operation changed before acknowledgment')
      data.active.splice(index, 1)
      return true
    })
  }

  async acknowledgeInterrupted(profileId: string, workspaceId: string, requestId: string): Promise<void> {
    await this.mutate((data) => {
      const index = data.active.findIndex((item) => item.profile_id === profileId && item.workspace_id === workspaceId)
      if (index < 0 || data.active[index].request_id !== requestId) throw new Error('Git operation changed before acknowledgment')
      const [intent] = data.active.splice(index, 1)
      data.archived.push({ intent, acknowledged_at: Date.now() })
      return true
    })
  }

  private async mutate(change: (data: JournalFile) => boolean): Promise<void> {
    const action = this.tail.then(async () => {
      if (this.unsafe) throw new Error('Git recovery journal persistence is uncertain; preserve it for recovery')
      const next: JournalFile = { version: 1, active: structuredClone(this.active), archived: structuredClone(this.archived) }
      if (!change(next)) return
      const payload = JSON.stringify(next)
      if (Buffer.byteLength(payload) > maxBytes) throw new Error('Git recovery journal is full')
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      let renamed = false
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(payload); await file.sync() }
        finally { await file.close() }
        await rename(temporary, this.file)
        renamed = true
        const directory = await open(dirname(this.file), 'r')
        try { await directory.sync() }
        finally { await directory.close() }
      } catch (error) {
        if (renamed) this.unsafe = true
        else await unlink(temporary).catch(() => undefined)
        throw error
      }
      this.active = next.active
      this.archived = next.archived
    })
    this.tail = action.catch(() => undefined)
    return action
  }
}
