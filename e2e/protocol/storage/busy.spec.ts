// Storage errors are reported as what they are. Under load, a daemon once
// refused a write with "lux-ade could not save these changes. Check available
// disk space..." while the disk had 123 GiB free: a busy database was reported
// as a full disk. Only SQLITE_FULL or ENOSPC may say to check disk space
// (the classification is `StorageFailure::classify` in ade-core, tested there).
//
// Here a test connection holds the profile database's write lock, as a second
// writer under load would, past the daemon's busy wait and its retry. The
// refusal must be `storage_busy` with a retry hint and no word about disk
// space, nothing may be saved, and the same request must succeed once the
// lock is released.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, prompts, test, type ScratchProfile } from '../fixtures'
import { opId, parentIn } from '../orchestration/steps'

/** Busy wait (5 s) times two lock attempts, with room for a slow machine. */
const HELD_CALL_MS = 40_000

type Refusal = { code: string; message: string; recovery?: string; replied?: boolean }

async function refusal(pending: Promise<unknown>): Promise<Refusal> {
  try {
    await pending
  } catch (error) {
    return error as Refusal
  }
  throw new Error('The request succeeded while the database was held')
}

/** Take the profile database's write lock on a separate connection. */
function holdWriteLock(profile: ScratchProfile): { release(): void } {
  const db = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  db.exec('BEGIN IMMEDIATE')
  return {
    release() {
      db.exec('ROLLBACK')
      db.close()
    },
  }
}

function expectTruthfulBusy(refused: Refusal): void {
  expect(refused, `${refused.message} ${JSON.stringify(refused)}`).toMatchObject({
    code: 'storage_busy',
    recovery: 'retry',
    replied: true,
  })
  expect(refused.message).toContain('busy')
  expect(refused.message).not.toMatch(/disk space/i)
}

test('a held profile database refuses a save as storage_busy, never as a full disk, and the retry saves it @fault', async ({
  profile,
}) => {
  test.setTimeout(120_000)
  const before = await profile.call('notification.preferences.get', {})
  const wanted = { desktop: !before.desktop, muted_kinds: [] }

  const lock = holdWriteLock(profile)
  let refused: Refusal
  try {
    refused = await refusal(profile.call('notification.preferences.set', wanted, { timeoutMs: HELD_CALL_MS }))
  } finally {
    lock.release()
  }
  expectTruthfulBusy(refused)
  // Nothing was saved.
  expect((await profile.call('notification.preferences.get', {})).desktop).toBe(before.desktop)

  // The same request, once the lock is free, saves.
  const saved = await profile.call('notification.preferences.set', wanted)
  expect(saved.desktop).toBe(wanted.desktop)
  expect((await profile.call('notification.preferences.get', {})).desktop).toBe(wanted.desktop)
})

test('a parallel run group started while another writer holds the database is refused as busy, then starts under the same operation ID @fault', async ({
  profile,
  repo,
}) => {
  // The incident's path: orchestration.group.start in parallel-runs.spec.ts.
  // Its transaction read before writing, so SQLite refused the write at once
  // instead of waiting, and the refusal blamed the disk.
  test.setTimeout(120_000)
  const { parent } = await parentIn(profile, repo.path)
  const request = {
    operation_id: opId('busy-group'),
    parent_conversation_id: parent,
    caller: { kind: 'agent' as const, conversation_id: parent },
    task: prompts.turn,
    runs: [
      { provider: 'codex' as const, account: { mode: 'inherit' as const }, workspace: { mode: 'same' as const } },
      { provider: 'claude' as const, account: { mode: 'ambient' as const }, workspace: { mode: 'same' as const } },
    ],
  }

  const lock = holdWriteLock(profile)
  let refused: Refusal
  try {
    refused = await refusal(profile.call('orchestration.group.start', request, { timeoutMs: HELD_CALL_MS }))
  } finally {
    lock.release()
  }
  expectTruthfulBusy(refused)
  // The refused transaction left nothing behind, not even its receipt.
  expect((await profile.call('orchestration.groups', { parent_conversation_id: parent })).groups).toEqual([])
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toEqual([])

  // A retry under the same operation ID runs the group once.
  const { group } = await profile.call('orchestration.group.start', request)
  expect(group.runs).toHaveLength(2)
  const replay = await profile.call('orchestration.group.start', request)
  expect(replay.group.group_id).toBe(group.group_id)
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toHaveLength(2)
})
