// In-process tests for the client journals over their Node file storage (AGENTS.md
// test policy). Delivery against a real daemon is proven by the protocol E2E
// `e2e/protocol/conversations/cli-journal.spec.ts`.
// Run after `pnpm build:sdk`: node --test packages/client/src/journals.test.mjs
import assert from 'node:assert/strict'
import fs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { ContractError } from '@ade/contracts'
import { test } from 'node:test'
import {
  deliverHeldSends,
  heldDirectSends,
  openClientJournals,
  sendGitMutation,
  GitOperationBlocked,
  GitJournal,
  SendHeld,
  SendPipeline,
  sendJournaled,
  socketProfileId,
} from '../dist/journals.js'

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-journals-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function fakeSendDaemon(t, socketPath) {
  let draft = { text: '', revision: 0, attachments: [], context_nodes: [] }
  let intent = null
  let outcome = 'prepared'
  let agentSendCalls = 0
  let effects = 0
  let stashes = []
  const effectRequests = new Set()
  const server = createServer((socket) => {
    let buffered = ''
    let greeted = false
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      for (;;) {
        const end = buffered.indexOf('\n')
        if (end < 0) return
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        const request = JSON.parse(line)
        if (!greeted) {
          greeted = true
          socket.write(
            JSON.stringify({
              type: 'hello',
              application_protocol: 'ade-application-v1',
              session_protocol: 'ade-sessions-v1',
            }) + '\n',
          )
          continue
        }
        let response
        switch (request.op) {
          case 'draft.get':
            response = { type: 'draft', draft: structuredClone(draft) }
            break
          case 'draft.send.get':
            response = { type: 'send_intent', intent: intent && structuredClone(intent), restored_from_backup: false }
            break
          case 'draft.send.list':
            response = {
              type: 'pending_sends',
              next_cursor: null,
              restored_from_backup: false,
              sends: intent ? [{ intent: structuredClone(intent), outcome }] : [],
            }
            break
          case 'draft.save':
            if (request.expected_revision !== undefined && request.expected_revision !== draft.revision) {
              response = { type: 'error', code: 'conflict', message: 'Draft revision changed' }
              break
            }
            draft = {
              text: request.text,
              revision: request.revision,
              attachments: request.attachments ?? [],
              context_nodes: request.context_nodes ?? [],
            }
            response = { type: 'draft', draft: structuredClone(draft) }
            break
          case 'draft.stash.save': {
            const existing = stashes.find((stash) => stash.name === request.name)
            const stash = {
              attachments: request.attachments ?? [],
              context_nodes: request.context_nodes ?? [],
              conversation_id: request.conversation_id,
              name: request.name,
              revision: existing ? existing.revision + 1 : 1,
              saved_at: Date.now(),
              text: request.text,
              window_id: request.window_id,
            }
            if (existing) stashes = stashes.map((item) => (item.name === request.name ? stash : item))
            else stashes.unshift(stash)
            response = {
              type: 'draft_stash',
              outcome: existing ? 'replaced' : 'created',
              stash: structuredClone(stash),
            }
            break
          }
          case 'draft.stash.list':
            response = { type: 'draft_stashes', stashes: structuredClone(stashes) }
            break
          case 'draft.stash.restore': {
            const selected = stashes.find(
              (stash) => stash.name === request.name && stash.revision === request.stash_revision,
            )
            if (!selected || request.expected_revision !== draft.revision) {
              response = {
                type: 'draft_restore',
                context_nodes: [],
                displaced_entry_id: null,
                draft: structuredClone(draft),
                outcome: 'conflict',
              }
              break
            }
            draft = {
              text: selected.text,
              revision: request.revision,
              attachments: selected.attachments,
              context_nodes: selected.context_nodes,
            }
            response = {
              type: 'draft_restore',
              context_nodes: structuredClone(draft.context_nodes),
              displaced_entry_id: null,
              draft: structuredClone(draft),
              outcome: 'restored',
            }
            break
          }
          case 'draft.send.prepare':
            intent = {
              attachments: request.attachments ?? [],
              context_nodes: request.context_nodes ?? [],
              conversation_id: request.conversation_id,
              draft_revision: request.revision,
              draft_text: request.draft_text,
              request_id: request.request_id,
              state: 'pending',
              text: request.text,
              window_id: request.window_id,
            }
            outcome = 'prepared'
            response = { type: 'send_intent', intent: structuredClone(intent) }
            break
          case 'agent.send':
            agentSendCalls++
            if (!effectRequests.has(request.request_id)) {
              effectRequests.add(request.request_id)
              effects++
            }
            socket.destroy()
            return
          case 'draft.send.acknowledge':
            draft = { ...draft, text: '', revision: draft.revision + 1 }
            intent = null
            response = {
              type: 'send_acknowledged',
              conversation_id: request.conversation_id,
              request_id: request.request_id,
              resolution: 'completed',
              draft: structuredClone(draft),
            }
            break
          default:
            response = { type: 'error', code: 'unsupported', message: 'Unsupported fixture operation' }
        }
        socket.end(JSON.stringify(response) + '\n')
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
  return {
    endpoint: socketPath,
    setDraft: (next) => {
      draft = structuredClone(next)
    },
    omitIntentContextNodes: () => {
      if (intent) delete intent.context_nodes
    },
    accept: () => {
      outcome = 'accepted'
      if (intent) intent.state = 'pending'
    },
    counts: () => ({ agentSendCalls, effects }),
  }
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
  contextNodes: [],
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

test('the draft owner ID is made once and kept; an invalid record is refused, not replaced', async (t) => {
  const directory = await scratch(t)
  const { ownerId } = await openClientJournals(directory)
  assert.match(ownerId, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.equal((await openClientJournals(directory)).ownerId, ownerId)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'window-owner-v1.json'), 'utf8')), { id: ownerId })
  await writeFile(join(directory, 'window-owner-v1.json'), '{"id":"../escape"}')
  await assert.rejects(openClientJournals(directory), /Window owner record is invalid/)
  assert.equal(await readFile(join(directory, 'window-owner-v1.json'), 'utf8'), '{"id":"../escape"}')
})

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

test('a send journal record without its admitted context snapshot is refused without replacing the valid record', async (t) => {
  const directory = await scratch(t)
  const { send } = await openClientJournals(directory)
  await send.upsert(record)
  const { contextNodes: _contextNodes, ...missingContext } = record
  await assert.rejects(send.upsert(missingContext), /Invalid send recovery record/)
  assert.deepEqual(await send.list(), [record])
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

test('a version 1 Git journal is refused and left in place', async (t) => {
  const directory = await scratch(t)
  const old = JSON.stringify({ version: 1, active: [gitIntent], archived: [{ intent: gitIntent }] })
  await writeFile(join(directory, 'git-intents-v1.json'), old)
  await assert.rejects(openClientJournals(directory), /Git recovery journal version 1 is not read by this build/)
  assert.equal(await readFile(join(directory, 'git-intents-v1.json'), 'utf8'), old)
})

test('a refused journal waits for its outstanding owner-file write before returning', { timeout: 5000 }, async (t) => {
  const directory = await scratch(t)
  await writeFile(join(directory, 'git-intents-v1.json'), JSON.stringify({ version: 1, active: [], archived: [] }))
  let entered
  let release
  const writing = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let refused
  const refusal = new Promise((resolve) => {
    refused = resolve
  })
  const originalGitOpen = GitJournal.open.bind(GitJournal)
  const gitOpen = t.mock.method(GitJournal, 'open', async (...args) => {
    try {
      return await originalGitOpen(...args)
    } catch (error) {
      refused()
      throw error
    }
  })
  const original = fs.open
  const patched = t.mock.method(fs, 'open', async (file, ...args) => {
    if (String(file).startsWith(join(directory, 'window-owner-v1.json.'))) {
      entered()
      await gate
    }
    return original(file, ...args)
  })
  syncBuiltinESMExports()
  let settled = false
  const opening = openClientJournals(directory).then(
    () => {
      settled = true
      return null
    },
    (error) => {
      settled = true
      return error
    },
  )
  try {
    await writing
    await refusal
    // Flush rejection handlers after the real read failed, while the sibling write is held.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false, 'A rejected open must not leave a writer racing directory cleanup')
  } finally {
    release()
    const error = await opening
    patched.mock.restore()
    gitOpen.mock.restore()
    syncBuiltinESMExports()
    assert.match(error?.message ?? '', /Git recovery journal version 1/)
  }
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

/** A window's entry as `SendPipeline.open` makes it, with no daemon behind it. */
function entry(directory, fields = {}) {
  return {
    endpoint: join(directory, 'no-daemon.sock'),
    profileId: 'profile-a',
    windowId: 'window-a',
    conversationId: 'conversation-a',
    draft: { text: 'draft', revision: 1, attachments: [], context_nodes: [] },
    timer: null,
    pending: Promise.resolve(),
    savedRevision: 1,
    error: '',
    unclearedText: '',
    send: null,
    ...fields,
  }
}

const preparing = {
  requestId: 'request-a',
  text: 'Fix the build',
  draftText: 'Fix the build',
  revision: 1,
  attachments: [],
  contextNodes: [],
  state: 'pending',
  preparing: true,
  admitted: false,
  inFlight: null,
}
test('separate views share one owner send intent, keep their drafts, and reconcile without redispatch after restart', async (t) => {
  const directory = await scratch(t)
  const endpoint = join(directory, 'daemon.sock')
  const daemon = await fakeSendDaemon(t, endpoint)
  const journal = (await openClientJournals(directory)).send
  const owner = { endpoint, profileId: 'profile-a', windowId: 'stable-owner', conversationId: 'conversation-a' }
  const pipeline = new SendPipeline(journal)
  const [viewA, viewB] = await Promise.all([
    pipeline.open(owner, { viewId: 'view-a' }),
    pipeline.open(owner, { viewId: 'view-b' }),
  ])
  const viewAContext = [{ id: 'send-context-a', kind: 'reference', data: { label: 'View A context' } }]
  viewA.draft = { text: 'View A draft', revision: 1, attachments: [], context_nodes: viewAContext }
  const viewBContext = [{ id: 'send-context-b', kind: 'reference', data: { label: 'View B context' } }]
  viewB.draft = { text: 'Keep this view B draft', revision: 1, attachments: [], context_nodes: viewBContext }

  const firstSend = pipeline.send(viewA, 'request-cross-view', 'Run this once')
  assert.deepEqual(await pipeline.send(viewB, 'request-cross-view', 'Run this once'), {
    type: 'send_pending',
    request_id: 'request-cross-view',
    text: 'Run this once',
  })
  await assert.rejects(pipeline.send(viewB, 'request-successor', 'A different prompt'), /Resolve the previous prompt/)
  assert.strictEqual(viewA.send, viewB.send)
  assert.equal(viewB.draft.text, 'Keep this view B draft')
  assert.deepEqual(viewB.draft.context_nodes, viewBContext)

  assert.deepEqual(await firstSend, {
    type: 'send_pending',
    request_id: 'request-cross-view',
    text: 'Run this once',
    message: 'Prompt delivery is unconfirmed. Retry will use the same request ID.',
  })
  assert.deepEqual(daemon.counts(), { agentSendCalls: 1, effects: 1 })
  assert.deepEqual(await journal.list(), [])

  daemon.setDraft({
    text: 'A later draft',
    revision: 2,
    attachments: [],
    context_nodes: [{ id: 'later-context', kind: 'reference', data: { label: 'Do not substitute this context' } }],
  })
  const restarted = new SendPipeline(journal)
  const recovered = await restarted.open(owner, { viewId: 'reopened-view-a' })
  assert.equal(recovered.send?.requestId, 'request-cross-view')
  assert.deepEqual(recovered.send?.contextNodes, viewAContext)
  daemon.accept()
  assert.deepEqual(await restarted.retry(recovered, 'request-cross-view'), {
    type: 'ack',
    request_id: 'request-cross-view',
    reconciled: true,
  })
  assert.deepEqual(daemon.counts(), { agentSendCalls: 1, effects: 1 })
  assert.equal(recovered.send, null)
})

test('empty admitted context is preserved and a missing daemon snapshot is refused rather than replaced from the current draft', async (t) => {
  const directory = await scratch(t)
  const endpoint = join(directory, 'daemon.sock')
  const daemon = await fakeSendDaemon(t, endpoint)
  const journal = (await openClientJournals(directory)).send
  const owner = { endpoint, profileId: 'profile-a', windowId: 'stable-owner', conversationId: 'conversation-a' }
  const pipeline = new SendPipeline(journal)
  const view = await pipeline.open(owner, { viewId: 'view-a' })
  view.draft = { text: 'Draft captured at send', revision: 1, attachments: [], context_nodes: [] }

  assert.equal((await pipeline.send(view, 'request-empty-context', 'Run this once')).type, 'send_pending')
  assert.deepEqual(daemon.counts(), { agentSendCalls: 1, effects: 1 })

  const laterContext = [{ id: 'later-context', kind: 'reference', data: { label: 'Current draft only' } }]
  daemon.setDraft({ text: 'Later draft', revision: 2, attachments: [], context_nodes: laterContext })
  const recovered = await new SendPipeline(journal).open(owner, { viewId: 'reopened-view' })
  assert.deepEqual(recovered.send?.contextNodes, [])
  assert.deepEqual(recovered.draft.context_nodes, laterContext)

  daemon.omitIntentContextNodes()
  await assert.rejects(
    new SendPipeline(journal).open(owner, { viewId: 'invalid-recovery' }),
    (error) => error instanceof ContractError,
  )
  assert.deepEqual(daemon.counts(), { agentSendCalls: 1, effects: 1 })
})
test('stale-view draft text and context remain recoverable across restart and restore', async (t) => {
  const directory = await scratch(t)
  const endpoint = join(directory, 'daemon.sock')
  await fakeSendDaemon(t, endpoint)
  const journal = (await openClientJournals(directory)).send
  const owner = { endpoint, profileId: 'profile-a', windowId: 'stable-owner', conversationId: 'conversation-a' }
  const pipeline = new SendPipeline(journal)
  const [viewA, viewB] = await Promise.all([
    pipeline.open(owner, { viewId: 'view-a' }),
    pipeline.open(owner, { viewId: 'view-b' }),
  ])
  const contextA = [{ id: 'context-a', kind: 'reference', data: { label: 'Saved view context' } }]
  const contextB = [{ id: 'context-b', kind: 'reference', data: { label: 'Local view context' } }]
  viewA.draft = { text: 'Saved by view A', revision: 1, attachments: [], context_nodes: contextA }
  viewB.draft = { text: 'Keep this local draft', revision: 1, attachments: [], context_nodes: contextB }

  await pipeline.flush(viewA)
  await pipeline.flush(viewB)
  assert.equal(viewB.savedRevision, 0)
  assert.equal(viewB.draft.text, 'Keep this local draft')
  assert.match(viewB.error, /saved for recovery/)

  const restarted = new SendPipeline(journal)
  const recoveryView = await restarted.open(owner, { viewId: 'view-b-restarted' })
  assert.equal(recoveryView.draft.text, 'Saved by view A')
  const stashes = await restarted.listDraftStashes(recoveryView)
  const local = stashes.find((stash) => stash.text === 'Keep this local draft')
  assert.ok(local)
  assert.deepEqual(local.context_nodes, contextB)
  const restored = await restarted.restoreDraftStash(recoveryView, local.name, local.revision)
  assert.equal(restored.outcome, 'restored')
  assert.equal(recoveryView.draft.text, 'Keep this local draft')
  assert.deepEqual(recoveryView.draft.context_nodes, contextB)
  assert.equal(recoveryView.savedRevision, 2)
  assert.ok(
    (await restarted.listDraftStashes(recoveryView)).some(
      (stash) => stash.text === 'Saved by view A' && JSON.stringify(stash.context_nodes) === JSON.stringify(contextA),
    ),
  )
})

test('the send pipeline holds one prompt per window and Conversation, and a retry names it', async (t) => {
  const directory = await scratch(t)
  const pipeline = new SendPipeline((await openClientJournals(directory)).send)
  await assert.rejects(pipeline.send(entry(directory), 'bad id!', 'text'), /Invalid prompt/)
  await assert.rejects(pipeline.send(entry(directory), 'request-a', '   '), /Invalid prompt/)
  await assert.rejects(pipeline.retry(entry(directory)), /No prompt is awaiting confirmation/)
  const cleared = entry(directory, { unclearedText: 'sent before' })
  await assert.rejects(pipeline.send(cleared, 'request-b', 'next'), /Finish clearing the previous sent draft/)

  const busy = entry(directory, { send: { ...preparing } })
  await assert.rejects(pipeline.send(busy, 'request-b', 'Fix the build'), /Resolve the previous prompt/)
  await assert.rejects(pipeline.send(busy, 'request-a', 'Another prompt'), /Resolve the previous prompt/)
  await assert.rejects(pipeline.retry(busy, 'request-b'), /A different prompt is awaiting confirmation/)
  // The same prompt again, while it is still being prepared, is reported pending.
  const pending = { type: 'send_pending', request_id: 'request-a', text: 'Fix the build' }
  assert.deepEqual(await pipeline.send(busy, 'request-a', 'Fix the build'), pending)
  assert.deepEqual(await pipeline.retry(busy), pending)
  assert.deepEqual(await pipeline.retry(busy, 'request-a'), pending)
})
