// conversation.delete: an effect command with an operation ID and a receipt
// that commits with the deletion. It refuses while a turn runs, stops an idle
// Agent, removes the history, drafts, queue, send intents, snooze and its
// tabs in every layout, and leaves a tombstone so every later read, write, page and
// search refuses the Conversation as deleted (architecture section 6). Its
// attachment payloads stay until the existing reclaim rules free them. R011
// (delete half) is in restarts/stale-rewind.spec.ts; F043's search half is in
// catalogs/history.spec.ts.
import {
  cancelActiveSubmission,
  conversationStatus,
  expect,
  isRunning,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  type ScratchProfile,
} from '../fixtures'
import { conversationOn, profileWithClis, verifiedAccount } from '../providers/steps'

type Refusal = { code?: string; message: string }

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise
  } catch (error) {
    return { code: (error as { code?: string }).code, message: String((error as Error).message ?? error) }
  }
  throw new Error('The request was not refused')
}

async function hits(profile: ScratchProfile, query: string): Promise<number> {
  return (await profile.call('history.search', { query, limit: 50 })).results.length
}

let uploads = 0
async function upload(profile: ScratchProfile, conversationId: string, text: string) {
  return (
    await profile.call('attachment.put', {
      conversation_id: conversationId,
      request_id: `delete-upload-${++uploads}`,
      name: `notes-${uploads}.txt`,
      data: Buffer.from(text).toString('base64'),
    })
  ).attachment
}

/** The pids of the Codex mock processes a profile started. */
async function codexPids(profile: ScratchProfile): Promise<number[]> {
  const calls = (await profile.mockCalls('codex')) as Array<{ pid?: number }>
  return [...new Set(calls.map((call) => call.pid).filter((pid): pid is number => typeof pid === 'number'))]
}

test('deletes an idle conversation once: history, drafts, queue, snooze and tabs go, a tombstone refuses every later use, and a retry replays the receipt', async ({
  profile,
}) => {
  test.setTimeout(90_000)
  const { workspaceId, conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'hello pangolinquill')
  await waitForIdle(profile, conversationId)
  // Another Conversation in the same workspace keeps everything it has.
  const other = await startConversation(profile, 'codex')
  const kept = await upload(profile, other.conversationId, 'kept by its draft\n')
  await profile.call('draft.save', {
    conversation_id: other.conversationId,
    window_id: 'window-other',
    revision: 1,
    text: 'still here',
    attachments: [kept],
  })

  // Everything a deletion must clean up.
  const attached = await upload(profile, conversationId, 'referenced only by the deleted draft\n')
  const owner = { conversation_id: conversationId, window_id: 'window-delete' }
  await profile.call('draft.save', { ...owner, revision: 1, text: 'draft pangolinquill', attachments: [attached] })
  await profile.call('draft.send.prepare', {
    ...owner,
    request_id: 'delete-pending-send',
    draft_text: 'draft pangolinquill',
    text: 'draft pangolinquill',
    revision: 1,
    attachments: [attached],
  })
  await profile.call('queue.pause', { conversation_id: conversationId, paused: true })
  await profile.call('queue.enqueue', {
    conversation_id: conversationId,
    request_id: 'delete-queued',
    text: 'queued later',
  })
  await profile.call('conversation.snooze', { conversation_id: conversationId, until: Date.now() + 3_600_000 })
  await profile.call('window.create', { window_id: 'window-delete', workspace_id: workspaceId })
  for (const [tab, id] of [
    ['tab-deleted', conversationId],
    ['tab-other', other.conversationId],
  ] as const) {
    await profile.call('layout.apply', {
      window_id: 'window-delete',
      action: { type: 'open_tab', tab: { id: tab, target: { kind: 'conversation', id } } },
    })
  }
  expect(await shownConversations(profile, 'window-delete')).toEqual([conversationId, other.conversationId])
  await expect.poll(() => hits(profile, 'pangolinquill'), { timeout: 20_000 }).toBe(1)
  const agents = await codexPids(profile)
  expect(agents.length).toBeGreaterThan(0)

  const deleted = await profile.call('conversation.delete', {
    operation_id: 'delete-once',
    conversation_id: conversationId,
  })
  expect(deleted).toMatchObject({
    type: 'conversation_deleted',
    operation_id: 'delete-once',
    conversation_id: conversationId,
    workspace_id: workspaceId,
    attachments_left_for_retention: 1,
    removed: {
      messages: 2,
      requests: 0,
      drafts: 1,
      queued_prompts: 1,
      send_intents: 1,
      snoozes: 1,
      layouts_changed: 1,
    },
  })
  // The idle Agent was stopped before the deletion.
  for (const pid of agents) await expect.poll(() => isRunning(pid)).toBe(false)

  // A retry of the same operation returns the recorded reply; the ID with another payload conflicts.
  expect(
    await profile.call('conversation.delete', { operation_id: 'delete-once', conversation_id: conversationId }),
  ).toEqual(deleted)
  expect(
    (
      await refusal(
        profile.call('conversation.delete', { operation_id: 'delete-once', conversation_id: other.conversationId }),
      )
    ).message,
  ).toMatch(/already used for a different request/)
  expect((await profile.call('conversation.get', { conversation_id: other.conversationId })).conversation.id).toBe(
    other.conversationId,
  )

  // The tombstone refuses every read and write that names the Conversation, with one code.
  const refusals = await Promise.all(
    [
      profile.call('conversation.delete', { operation_id: 'delete-again', conversation_id: conversationId }),
      profile.call('conversation.get', { conversation_id: conversationId }),
      profile.call('conversation.get', { conversation_id: conversationId, before: 3, limit: 1, history_epoch: 0 }),
      profile.call('conversation.controls', { conversation_id: conversationId }),
      profile.call('agent.send', { conversation_id: conversationId, request_id: 'after-delete', text: 'hello' }),
      profile.call('agent.resume', { conversation_id: conversationId }),
      profile.call('draft.get', owner),
      profile.call('draft.save', { ...owner, revision: 2, text: 'late draft' }),
      profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'late-queued', text: 'late' }),
      profile.call('attachment.put', {
        conversation_id: conversationId,
        request_id: 'late-upload',
        name: 'late.txt',
        data: Buffer.from('late\n').toString('base64'),
      }),
      profile.call('conversation.snooze', { conversation_id: conversationId, until: Date.now() + 60_000 }),
      profile.call('history.search', { query: 'pangolinquill', conversation_id: conversationId }),
    ].map(refusal),
  )
  for (const refused of refusals) {
    expect(refused).toEqual({
      code: 'conversation_deleted',
      message: `Conversation ${conversationId} was deleted; reload the conversation list`,
    })
  }

  // A tab can no longer show it.
  const reopened = await refusal(
    profile.call('layout.apply', {
      window_id: 'window-delete',
      action: { type: 'open_tab', tab: { id: 'tab-late', target: { kind: 'conversation', id: conversationId } } },
    }),
  )
  expect(reopened.code).toBe('tab_target_missing')

  // Listings leave it out; the window's layout lost its tab and kept the other.
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.catalog.conversations.map((conversation) => conversation.id)).not.toContain(conversationId)
  expect(catalog.catalog.conversations.map((conversation) => conversation.id)).toContain(other.conversationId)
  expect(await shownConversations(profile, 'window-delete')).toEqual([other.conversationId])
  const listed = await profile.call('history.list', { workspace_id: workspaceId })
  expect(listed.conversations.map((entry) => entry.provenance.conversation_id)).not.toContain(conversationId)
  expect(await hits(profile, 'pangolinquill')).toBe(0)
  expect((await profile.call('draft.send.list', { window_id: 'window-delete' })).sends).toEqual([])

  // The payload stays until an explicit reclaim frees it; nothing references it now.
  const preview = await profile.call('attachment.reclaim.preview', {
    conversation_id: conversationId,
    attachment_id: attached.id,
  })
  expect(preview.preview).toMatchObject({
    state: 'live',
    reclaimable: true,
    protected_by: [],
    payload_bytes: attached.size,
  })
  const reclaimed = await profile.call('attachment.reclaim.apply', {
    conversation_id: conversationId,
    attachment_id: attached.id,
    expected_generation: preview.preview.generation,
  })
  expect(reclaimed.reclaimed_payload_bytes).toBe(attached.size)
  // The other Conversation's referenced upload is untouched and still protected.
  expect(
    (
      await profile.call('attachment.reclaim.preview', {
        conversation_id: other.conversationId,
        attachment_id: kept.id,
      })
    ).preview,
  ).toMatchObject({ state: 'live', reclaimable: false, protected_by: ['draft'] })
  expect(
    (await profile.call('draft.get', { conversation_id: other.conversationId, window_id: 'window-other' })).draft,
  ).toMatchObject({ text: 'still here', attachments: [kept] })
})

/** The Conversations the window's tabs show, in tab ID order. */
async function shownConversations(profile: ScratchProfile, windowId: string): Promise<string[]> {
  const { layout } = await profile.call('layout.get', { window_id: windowId })
  return Object.values(layout.layout.tabs).flatMap((tab) => (tab.target.kind === 'conversation' ? [tab.target.id] : []))
}

test('refuses a delete while a turn runs and records nothing, then deletes under the same operation ID once the turn is cancelled', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.active_turn_id,
    )
    .toBeTruthy()
  const busy = await refusal(
    profile.call('conversation.delete', { operation_id: 'delete-busy', conversation_id: conversationId }),
  )
  expect(busy.message).toMatch(/Cancel the active turn before deleting this Conversation/)
  // The turn was not touched.
  expect(await conversationStatus(profile, conversationId)).toBe('running')

  await cancelActiveSubmission(profile, conversationId)
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  // The refusal left no receipt, so the same ID now deletes.
  const deleted = await profile.call('conversation.delete', {
    operation_id: 'delete-busy',
    conversation_id: conversationId,
  })
  expect(deleted.conversation_id).toBe(conversationId)
  // The prompt, and whatever the provider wrote before the cancel.
  expect(deleted.removed.messages).toBeGreaterThanOrEqual(1)
  expect((await refusal(profile.call('conversation.get', { conversation_id: conversationId }))).code).toBe(
    'conversation_deleted',
  )
})

test('a deletion survives a daemon kill: the tombstone holds, the receipt replays and a late page stays refused', async ({
  profile,
}) => {
  test.setTimeout(60_000)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'hello okapiwren')
  await waitForIdle(profile, conversationId)
  await expect.poll(() => hits(profile, 'okapiwren'), { timeout: 20_000 }).toBe(1)
  const page = await profile.call('conversation.get', { conversation_id: conversationId, limit: 1 })
  const olderPage = {
    conversation_id: conversationId,
    before: page.messages[0].sequence,
    limit: 50,
    history_epoch: page.history_epoch,
  }
  const deleted = await profile.call('conversation.delete', {
    operation_id: 'delete-before-kill',
    conversation_id: conversationId,
  })

  await profile.restartDaemon('kill')
  expect(
    await profile.call('conversation.delete', { operation_id: 'delete-before-kill', conversation_id: conversationId }),
  ).toEqual(deleted)
  expect((await refusal(profile.call('conversation.get', olderPage))).code).toBe('conversation_deleted')
  expect(
    (await profile.call('catalog.get', {})).catalog.conversations.map((conversation) => conversation.id),
  ).not.toContain(conversationId)
  await profile.call('history.index.rebuild', {
    expected_epoch: (await profile.call('history.index.status', {})).index.epoch,
  })
  await expect.poll(async () => (await profile.call('history.index.status', {})).index.caught_up).toBe(true)
  expect(await hits(profile, 'okapiwren')).toBe(0)
})

test('the CLI deletes a conversation, replays a retry, and reports a deleted one with its own code', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const first = await profile.cli('--operation-id', 'cli-delete-1', 'conversation', 'delete', conversationId)
  expect(first.code, first.stderr).toBe(0)
  expect(first.json).toMatchObject({
    type: 'conversation_deleted',
    operation_id: 'cli-delete-1',
    conversation_id: conversationId,
  })
  const retry = await profile.cli('--operation-id', 'cli-delete-1', 'conversation', 'delete', conversationId)
  expect(retry.json).toEqual(first.json)
  const inspect = await profile.cli('conversation', 'inspect', conversationId)
  expect(inspect.code).toBe(18)
  expect(inspect.json).toMatchObject({ type: 'error', code: 'conversation_deleted', recovery: 'reload_catalog' })
  const usage = await profile.cli('conversation', 'delete')
  expect(usage.code).toBe(2)
})

test('conversation.create refuses a disabled account with the error its launch uses', async ({ ade }) => {
  test.setTimeout(60_000)
  const { profile, clis } = await profileWithClis(ade)
  const account = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'work@example.invalid',
    account_id: 'org-work',
  })
  const { workspaceId, conversationId } = await conversationOn(profile, 'codex', account.id)
  await profile.call('account.disable', { account_id: account.id })
  const disabled = /^Conversation account is disabled in ADE; create or choose another account$/

  const created = await refusal(
    profile.call('conversation.create', { workspace_id: workspaceId, provider: 'codex', account_id: account.id }),
  )
  expect(created.message).toMatch(disabled)
  expect((await profile.call('catalog.get', {})).catalog.conversations).toHaveLength(1)

  // The conversation made before the disable fails its launch with the same error.
  const launch = await refusal(
    profile.call('agent.send', { conversation_id: conversationId, request_id: 'disabled-launch', text: 'hello' }),
  )
  expect(launch.message).toMatch(disabled)
})
