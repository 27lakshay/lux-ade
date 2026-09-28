// In-process tests for the client journals over their Node file storage (AGENTS.md
// test policy). Delivery against a real daemon is proven by the protocol E2E
// `e2e/protocol/conversations/cli-journal.spec.ts`.
// Run after `pnpm build:sdk`: node --test packages/client/src/journals.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deliverHeldSends,
  heldDirectSends,
  openClientJournals,
  sendGitMutation,
  GitOperationBlocked,
  SendHeld,
  sendJournaled,
  socketProfileId,
} from '../dist/journals.js'

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-journals-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const record = {
  profileId: 'profile-a',
  windowId: 'window-a',
  conversationId: 'conversation-a',
  requestId: 'request-a',
  endpoint: '/tmp/ade-missing.sock',
  text: 'hello',
  draftText: 'hello',
  draftRevision: 1,
  attachments: [],
  dispatchStarted: false,
}

const gitIntent = {
  profile_id: 'profile-a',
  workspace_id: 'workspace-a',
  op: 'review.stage',
  request_id: 'stage-not-a-uuid',
  path: 'a.txt',
  revision: '0123456789abcdef',
}

test('the send journal keeps a record across reopening and drops it only for its own request', async (t) => {
  const directory = await scratch(t)
  const first = await openClientJournals(directory)
  await first.send.upsert(record)
  await assert.rejects(first.send.upsert({ ...record, text: 'other' }), /Another prompt or payload/)
  const reopened = await openClientJournals(directory)
  assert.deepEqual(await reopened.send.list(), [record])
  assert.equal(await reopened.send.remove({ ...record, requestId: 'request-b' }), false)
  assert.equal(await reopened.send.remove(record), true)
  assert.deepEqual(await (await openClientJournals(directory)).send.list(), [])
})

test('the Git journal holds one operation per workspace, with any CLI request ID', async (t) => {
  const directory = await scratch(t)
  const { git } = await openClientJournals(directory)
  await git.prepare(gitIntent)
  await git.prepare(gitIntent)
  await assert.rejects(git.prepare({ ...gitIntent, request_id: 'another' }), /Another Git operation/)
  await assert.rejects(git.prepare({ ...gitIntent, request_id: 'bad\nid' }), /Invalid Git recovery intent/)
  assert.deepEqual(await (await openClientJournals(directory)).git.pending('profile-a', 'workspace-a'), gitIntent)
  assert.equal(await git.release('profile-a', 'workspace-a', 'another'), false)
  assert.equal(await git.release('profile-a', 'workspace-a', gitIntent.request_id), true)
  assert.equal(await git.pending('profile-a', 'workspace-a'), null)
})

test('a version 1 Git journal keeps its active records and drops archived acknowledgements', async (t) => {
  const directory = await scratch(t)
  await writeFile(
    join(directory, 'git-intents-v1.json'),
    JSON.stringify({ version: 1, active: [gitIntent], archived: [{ intent: gitIntent }] }),
  )
  const { git } = await openClientJournals(directory)
  assert.deepEqual(await git.pending('profile-a', 'workspace-a'), gitIntent)
  await git.release('profile-a', 'workspace-a', gitIntent.request_id)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'git-intents-v1.json'), 'utf8')), {
    version: 2,
    records: [],
  })
})

test('a corrupt journal file is refused and left for recovery', async (t) => {
  const directory = await scratch(t)
  await writeFile(join(directory, 'pending-sends-v1.json'), '{not json')
  await assert.rejects(openClientJournals(directory), /Send recovery journal is invalid/)
  assert.equal(await readFile(join(directory, 'pending-sends-v1.json'), 'utf8'), '{not json')
})

test('a prompt whose daemon is unreachable stays held and is delivered only by a later attempt', async (t) => {
  const directory = await scratch(t)
  const { send } = await openClientJournals(directory)
  const endpoint = join(directory, 'no-daemon.sock')
  const owner = { endpoint, profileId: socketProfileId(endpoint), conversationId: 'conversation-a' }
  const error = await sendJournaled(send, owner, { requestId: 'held-1', text: 'hello' }).catch((failure) => failure)
  assert.ok(error instanceof SendHeld)
  assert.equal(error.code, 'unavailable')
  assert.equal(error.requestId, 'held-1')
  assert.deepEqual(
    (await heldDirectSends(send, owner.profileId)).map((item) => item.requestId),
    ['held-1'],
  )
  // A different prompt for the same Conversation waits for the held one.
  await assert.rejects(sendJournaled(send, owner, { requestId: 'held-2', text: 'next' }), /held-1/)
  // Delivery while the daemon is still away keeps it held.
  assert.deepEqual(await deliverHeldSends(send, endpoint, owner.profileId), [
    {
      request_id: 'held-1',
      conversation_id: 'conversation-a',
      outcome: 'held',
      code: 'unavailable',
      message: error.failure.message,
    },
  ])
  assert.equal((await heldDirectSends(send, owner.profileId)).length, 1)
  // Another profile's prompts are not this profile's to deliver.
  assert.deepEqual(await deliverHeldSends(send, endpoint, 'fixed-other'), [])
})

test('a socket reached without a managed profile gets a stable profile ID', () => {
  assert.equal(socketProfileId('/tmp/a/../a/d.sock'), socketProfileId('/tmp/a/d.sock'))
  assert.match(socketProfileId('/tmp/a/d.sock'), /^fixed-[0-9a-f]{32}$/)
  assert.notEqual(socketProfileId('/tmp/a/d.sock'), socketProfileId('/tmp/b/d.sock'))
})

test('a Git request ID is limited in UTF-8 bytes, as the contract limits it', async (t) => {
  const { git } = await openClientJournals(await scratch(t))
  // 128 two-byte characters are 256 bytes; one more is 258 bytes in 129 characters.
  await git.prepare({ ...gitIntent, request_id: 'é'.repeat(128) })
  await git.release('profile-a', 'workspace-a', 'é'.repeat(128))
  await assert.rejects(git.prepare({ ...gitIntent, request_id: 'é'.repeat(129) }), /Invalid Git recovery intent/)
})

test('a Git mutation that never reached the daemon leaves the journal, so it blocks nothing', async (t) => {
  const directory = await scratch(t)
  const { git } = await openClientJournals(directory)
  const endpoint = join(directory, 'no-daemon.sock')
  await assert.rejects(sendGitMutation(git, endpoint, gitIntent, { oneAtATime: false }), { delivery: 'not_sent' })
  assert.equal(await git.pending('profile-a', 'workspace-a'), null)
  // Another mutation in the workspace is not blocked by the unsent one.
  await assert.rejects(
    sendGitMutation(git, endpoint, { ...gitIntent, request_id: 'another' }, { oneAtATime: false }),
    (error) => !(error instanceof GitOperationBlocked),
  )
  assert.equal(await git.pending('profile-a', 'workspace-a'), null)
})
