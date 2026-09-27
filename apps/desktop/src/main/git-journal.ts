// The Git outbox keeps only Git mutations the profile daemon has not admitted, one
// per profile and workspace. After admission the daemon's receipts own the rest:
// `review.operation.list` shows running and interrupted operations, and
// `review.operation.acknowledge` records that the person saw an interrupted one.
import { Outbox, type OutboxCodec } from '@ade/client/outbox'
import { fileOutboxStorage } from './outbox-file'

export type GitIntent = { profile_id: string; workspace_id: string;
  op: 'review.stage' | 'review.unstage' | 'review.commit' | 'review.discard';
  request_id: string; path?: string; revision?: string; diff_token?: string; index_token?: string; message?: string }
const id = /^[a-zA-Z0-9_-]{1,128}$/
const uuid = /^[0-9a-f-]{36}$/
const token = /^[0-9a-f]{16}$/
const maxRecords = 256

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

/**
 * Version 2 holds `records`. Version 1 held `active` and `archived`. Active records
 * carry over, because one may still be unadmitted. Archived records were
 * acknowledgements that the daemon now keeps itself, so they are dropped: an
 * interrupted operation acknowledged only in version 1 shows once more, for the
 * person to acknowledge through the daemon.
 */
const codec: OutboxCodec<GitIntent> = {
  version: 2,
  name: 'Git recovery journal',
  maxRecords,
  key,
  decode(data: unknown): GitIntent[] {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Git recovery journal is invalid; preserve it for recovery')
    const value = data as Record<string, unknown>
    const fields = Object.keys(value).sort().join(',')
    let records: unknown
    if (value.version === 1 && fields === 'active,archived,version' && Array.isArray(value.archived)) records = value.active
    else if (value.version === 2 && fields === 'records,version') records = value.records
    else throw new Error('Git recovery journal is invalid; preserve it for recovery')
    if (!Array.isArray(records) || records.some((item) => !valid(item))) {
      throw new Error('Git recovery journal is invalid; preserve it for recovery')
    }
    return records as GitIntent[]
  },
}

export class GitJournal {
  private constructor(private readonly outbox: Outbox<GitIntent>) {}

  static async open(file: string): Promise<GitJournal> {
    return new GitJournal(await Outbox.open(fileOutboxStorage(file, codec.name), codec))
  }

  /** The unadmitted operation for this profile and workspace, if any. */
  pending(profileId: string, workspaceId: string): Promise<GitIntent | null> {
    return this.outbox.get(key({ profile_id: profileId, workspace_id: workspaceId }))
  }

  /** Records an operation before it is sent. A second operation for the same workspace is refused. */
  async prepare(intent: GitIntent): Promise<void> {
    if (!valid(intent)) throw new Error('Invalid Git recovery intent')
    await this.outbox.put(intent, (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
      'Another Git operation needs reconciliation in this workspace')
  }

  /** Drops the record once the daemon holds the operation or its outcome is settled. */
  release(profileId: string, workspaceId: string, requestId: string): Promise<boolean> {
    return this.outbox.remove(key({ profile_id: profileId, workspace_id: workspaceId }),
      (record) => record.request_id === requestId)
  }
}
