import { mkdir, utimes, writeFile, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  cancellationIntent,
  expect,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForMessage,
} from './fixtures'
import { mockDirectory } from './fixtures/providers'
import { codexMessage, codexRollout } from './fixtures/native-sessions'

const effects: Record<string, true> = {
  'thread/start': true,
  'thread/resume': true,
  'thread/fork': true,
  'thread/rollback': true,
  'thread/compact/start': true,
  'turn/start': true,
  'turn/steer': true,
  'turn/interrupt': true,
}

test('identified native history pages retain exact byte windows, genuine cursors and measured source identity without effects', async ({
  profile,
}) => {
  const root = mockDirectory(profile.root, 'codex')
  await mkdir(root, { recursive: true })
  const mode = join(root, 'history-mode.json')
  await writeFile(mode, JSON.stringify({ historyMode: 'paginated', updatedAt: 1700000000 }))
  const { conversationId } = await startConversation(profile, 'codex')
  const unadmitted = await profile.call('conversation.history', { conversation_id: conversationId })
  expect(unadmitted.snapshot).toBeNull()
  expect(unadmitted.complete).toBe(false)
  expect((await profile.mockCalls('codex')).filter((call) => effects[call.method])).toEqual([])
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, 'Hello world')
  await waitForIdle(profile, conversationId)
  const before = (await profile.mockCalls('codex')).filter((call) => effects[call.method])
  const first = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 1 })
  expect(first.error).toBeNull()
  expect(first.messages.map((message) => message.text)).toEqual(['hello'])
  expect(first.snapshot?.size_bytes == null).toBe(true)
  expect(first.snapshot?.modified_at_ms).toBe(1700000000000)
  expect(first.snapshot?.consistency).toBe('best_effort')
  expect(first.complete).toBe(false)
  expect(first.stale).toBe(false)
  expect(first.next_native_cursor).toContain(':p:fixture-native:')
  expect(first.retained_bytes).toBe(Buffer.byteLength(JSON.stringify(first.messages)))
  const second = await profile.call('conversation.history', {
    conversation_id: conversationId,
    snapshot: first.snapshot,
    native_cursor: first.next_native_cursor,
    history_epoch: first.history_epoch,
    max_items: 1,
  })
  expect(second.error).toBeNull()
  expect(second.messages.map((message) => message.text)).toEqual(['Hello world'])
  expect(second.complete).toBe(true)
  expect(second.next_native_cursor).toBeNull()
  const cli = await profile.cli(
    'conversation',
    'history',
    conversationId,
    JSON.stringify({
      snapshot: first.snapshot,
      native_cursor: first.next_native_cursor,
      history_epoch: first.history_epoch,
      max_items: 1,
    }),
  )
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({
    type: 'conversation_history',
    messages: second.messages,
    complete: true,
    next_native_cursor: null,
  })
  const budget = first.retained_bytes + second.retained_bytes - 2
  const trimmed = await profile.call('conversation.history', {
    conversation_id: conversationId,
    max_items: 2,
    max_bytes: budget,
  })
  expect(trimmed.error).toBeNull()
  expect(trimmed.messages.map((message) => message.text)).toEqual(['hello'])
  expect(trimmed.retained_bytes).toBe(Buffer.byteLength(JSON.stringify(trimmed.messages)))
  expect(trimmed.retained_bytes).toBeLessThanOrEqual(budget)
  expect(trimmed.complete).toBe(false)
  expect(trimmed.next_native_cursor).toBe(first.next_native_cursor)
  const wrongEpoch = await profile.call('conversation.history', {
    conversation_id: conversationId,
    snapshot: first.snapshot,
    native_cursor: first.next_native_cursor,
    history_epoch: first.history_epoch + 1,
  })
  expect(wrongEpoch.error?.code).toBe('invalid_request')
  expect(wrongEpoch.messages).toEqual([])
  const source = join(root, 'measured-source')
  await writeFile(source, '')
  await utimes(source, 1700000000, 1700000000)
  await writeFile(mode, JSON.stringify({ historyMode: 'paginated', path: source, updatedAt: 1700000000 }))
  const zero = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 1 })
  expect(zero.error).toBeNull()
  expect(zero.snapshot?.size_bytes).toBe(0)
  await writeFile(source, 'x')
  await utimes(source, 1700000000, 1700000000)
  const changed = await profile.call('conversation.history', {
    conversation_id: conversationId,
    snapshot: zero.snapshot,
    native_cursor: zero.next_native_cursor,
    history_epoch: zero.history_epoch,
    max_items: 1,
  })
  expect(changed.error?.code).toBe('invalid_request')
  expect(changed.messages).toEqual([])
  expect(changed.stale).toBe(false)
  expect(changed.complete).toBe(false)
  const positive = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 1 })
  expect(positive.error).toBeNull()
  expect(positive.snapshot?.size_bytes).toBe(1)
  expect(positive.snapshot?.modified_at_ms).toBe(zero.snapshot?.modified_at_ms)
  expect(positive.snapshot?.generation).not.toBe(zero.snapshot?.generation)
  await writeFile(mode, JSON.stringify({ historyMode: 'paginated', ignored: Array.from({ length: 5000 }, () => 0) }))
  const oversized = await profile.call('conversation.history', { conversation_id: conversationId })
  expect(oversized.error?.code).toBe('resource_limit')
  expect(oversized.messages).toEqual([])
  expect(oversized.complete).toBe(false)
  expect(oversized.stale).toBe(false)
  const after = await profile.mockCalls('codex')
  expect(after.filter((call) => effects[call.method])).toEqual(before)
  for (const call of after.filter((call) => call.method === 'thread/read'))
    expect(call.params).toMatchObject({ includeTurns: false })
  for (const call of after.filter((call) => call.method === 'thread/items/list'))
    expect(call.params).toMatchObject({ limit: 1 })
})

test('public Codex SDK receipts distinguish durable admission, definite native refusal and uncertain transport while retaining exact prompts', async ({
  profile,
}, testInfo) => {
  const root = mockDirectory(profile.root, 'codex')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'immediate-startup'), '')
  const accepted = await startConversation(profile, 'codex')
  const requestId = 'public-receipt-accepted'
  await send(profile, accepted.conversationId, prompts.turn, requestId)
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: accepted.conversationId })).messages.find(
          (message) => message.id === requestId,
        )?.delivery?.terminal?.correlated,
    )
    .toBe(true)
  const acceptedSnapshot = await profile.call('conversation.get', { conversation_id: accepted.conversationId })
  const user = acceptedSnapshot.messages.find((message) => message.id === requestId)!
  expect(user.text).toBe(prompts.turn)
  expect(user.delivery).toMatchObject({
    admitted: true,
    dispatch: 'dispatched',
    native_outcome: 'accepted',
    request_id: requestId,
    recoverable_message_id: requestId,
  })
  expect(user.delivery?.terminal?.turn_id).toBe(user.delivery?.native_turn_id)
  expect(user.delivery?.terminal?.status).toBe('completed')
  expect(
    acceptedSnapshot.messages.filter((message) => message.role === 'assistant').map((message) => message.text),
  ).toEqual(['Hello world'])
  await expect
    .poll(async () =>
      (await profile.call('usage.limits', { provider: 'codex' })).windows.map((window) => window.used_percent),
    )
    .toEqual([13])
  const calls = await profile.mockCalls('codex')
  const submission = calls.find((call) => call.method === 'turn/start')!
  const frames = (await readFile(join(root, 'frames.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).frame as { id?: number; method?: string })
  expect(frames[0].method).toBe('account/rateLimits/updated')
  const replyIndex = frames.findIndex((frame) => frame.id === submission.id)
  expect(replyIndex).toBeGreaterThan(0)
  expect(
    frames
      .slice(0, replyIndex)
      .map((frame) => frame.method)
      .filter(Boolean),
  ).toEqual([
    'account/rateLimits/updated',
    'turn/started',
    'item/completed',
    'item/started',
    'item/agentMessage/delta',
    'item/agentMessage/delta',
    'item/completed',
    'turn/completed',
  ])
  await send(profile, accepted.conversationId, prompts.turn, requestId)
  for (const [text, outcome] of [
    ['receipt-reject', 'rejected'],
    ['receipt-disconnect', 'unknown'],
    ['receipt-malformed', 'unknown'],
  ] as const) {
    const { conversationId } = await startConversation(profile, 'codex')
    await send(profile, conversationId, text, text)
    await expect
      .poll(
        async () =>
          (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
            (message) => message.id === text,
          )?.delivery?.native_outcome,
      )
      .toBe(outcome)
    const message = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
      (message) => message.id === text,
    )!
    expect(message.text).toBe(text)
    expect(message.delivery).toMatchObject({
      admitted: true,
      dispatch: 'dispatched',
      native_outcome: outcome,
      recoverable_message_id: text,
      native_turn_id: null,
      terminal: null,
    })
    if (text === 'receipt-malformed') {
      expect(message.delivery?.error).toBe('invalid_data')
      expect(message.delivery?.recovery).toBe('reconnect_and_reconcile')
      await send(profile, conversationId, text, text)
      const replayed = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
        (entry) => entry.id === text,
      )!
      expect(replayed.delivery).toEqual(message.delivery)
    }
    if (text === 'receipt-reject') expect(message.delivery?.error).toBe('rejected')
    expect(message.delivery?.error).not.toBeNull()
    expect(message.delivery?.recovery).not.toBeNull()
  }
  const starts = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect(starts.map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)).toEqual([
    requestId,
    'receipt-reject',
    'receipt-disconnect',
    'receipt-malformed',
  ])
  await profile.restartDaemon()
  const restored = (await profile.call('conversation.get', { conversation_id: accepted.conversationId })).messages.find(
    (message) => message.id === requestId,
  )!
  expect(restored.text).toBe(prompts.turn)
  await testInfo.attach('native-receipt-evidence.json', {
    body: JSON.stringify({
      beforeReplyFrames: frames,
      nativeCalls: await profile.mockCalls('codex'),
      accepted: user.delivery,
      restored: restored.delivery,
    }),
    contentType: 'application/json',
  })
  expect(restored.delivery).toEqual(user.delivery)
})

test('file-backed native history preserves oldest-first source order, proven imported IDs and unknown ADE positions beyond the imported prefix', async ({
  profile,
}) => {
  const session = 'e67c8dc5-4adb-433e-9f12-25c6a7dd1c5b'
  const workspace = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace
  const native = await codexRollout(profile.home, session, profile.defaultWorkspaceRoot, [
    codexMessage('user', 'first native user'),
    codexMessage('assistant', 'second native assistant'),
    {
      timestamp: '2026-09-06T13:36:08.123Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'orphan-pinned-call', output: 'orphan native output' },
    },
  ])
  const imported = await profile.call('history.import.session', {
    provider: 'codex',
    native_session_id: session,
    workspace_id: workspace.id,
  })
  const conversationId = imported.conversation.provenance.conversation_id
  const stored = (await profile.call('conversation.get', { conversation_id: conversationId })).messages
  const first = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 1 })
  expect(first.messages.map((message) => ({ id: message.id, sequence: message.sequence }))).toEqual([
    { id: stored[0].id, sequence: stored[0].sequence },
  ])
  const second = await profile.call('conversation.history', {
    conversation_id: conversationId,
    snapshot: first.snapshot,
    native_cursor: first.next_native_cursor,
    max_items: 1,
  })
  expect(second.messages.map((message) => ({ id: message.id, sequence: message.sequence }))).toEqual([
    { id: stored[1].id, sequence: stored[1].sequence },
  ])
  const third = await profile.call('conversation.history', {
    conversation_id: conversationId,
    snapshot: second.snapshot,
    native_cursor: second.next_native_cursor,
    max_items: 1,
  })
  expect(third.messages.map((message) => ({ id: message.id, sequence: message.sequence }))).toEqual([
    { id: stored[2].id, sequence: stored[2].sequence },
  ])
  expect(third.messages[0].content).toMatchObject({
    type: 'tool',
    call_id: 'orphan-pinned-call',
    input: null,
    output: 'orphan native output',
  })
  expect(third.messages[0].status).toBe('unknown')
  await native.append([
    ...Array.from({ length: 110 }, () => ({
      timestamp: '2026-09-06T13:36:09.456Z',
      type: 'event_msg',
      payload: { type: 'token_count', ignored: 'x'.repeat(20000) },
    })),
    codexMessage('assistant', 'unimported native tail', 10),
  ])
  let page = await profile.call('conversation.history', { conversation_id: conversationId })
  const messages = [...page.messages]
  for (let reads = 0; !page.complete; reads++) {
    expect(reads).toBeLessThan(8)
    expect(page.error).toBeNull()
    expect(page.next_native_cursor).not.toBeNull()
    page = await profile.call('conversation.history', {
      conversation_id: conversationId,
      snapshot: page.snapshot,
      native_cursor: page.next_native_cursor,
    })
    messages.push(...page.messages)
  }
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  expect(messages.slice(0, 2).map((message) => message.text)).toEqual(['first native user', 'second native assistant'])
  expect(messages[2].content).toMatchObject({
    type: 'tool',
    call_id: 'orphan-pinned-call',
    input: null,
    output: 'orphan native output',
  })
  expect(messages[3].text).toBe('unimported native tail')
  expect(messages.slice(0, 3).map((message) => ({ id: message.id, sequence: message.sequence }))).toEqual(
    stored.map((message) => ({ id: message.id, sequence: message.sequence })),
  )
  expect(messages[3].sequence).toBe(0)
  expect(messages[3].provider_item_id).toMatch(/^byte:/)
  expect(messages[3].id).toContain(':byte:')
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).messages).toEqual(stored)
  expect(await profile.mockCalls('codex')).toEqual([])
})

test('matching native reads coalesce while cancellation stays live and an epoch change fences the late source reply', async ({
  profile,
}) => {
  const root = mockDirectory(profile.root, 'codex')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'history-mode.json'), JSON.stringify({ historyMode: 'paginated' }))
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold, 'history-control-send')
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
          (message) => message.id === 'history-control-send',
        )?.delivery?.native_turn_id,
    )
    .toBeTruthy()
  const turn = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.id === 'history-control-send',
  )!.delivery!.native_turn_id!
  await writeFile(join(root, 'history-hold'), '')
  const request = { conversation_id: conversationId, max_items: 1 }
  const one = profile.call('conversation.history', request)
  const two = profile.call('conversation.history', request)
  await expect.poll(() => readFile(join(root, 'history-held'), 'utf8').catch(() => '')).not.toBe('')
  await profile.call('agent.cancel', { ...(await cancellationIntent(profile, conversationId, turn)), turn_id: turn })
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  database
    .prepare(
      'INSERT INTO conversation_history_epochs(conversation_id,epoch) VALUES(?1,1) ON CONFLICT(conversation_id) DO UPDATE SET epoch=epoch+1',
    )
    .run(conversationId)
  database.close()
  await writeFile(join(root, 'history-release'), '')
  for (const reply of await Promise.all([one, two])) {
    expect(reply.error?.code).toBe('invalid_request')
    expect(reply.messages).toEqual([])
    expect(reply.complete).toBe(false)
    expect(reply.stale).toBe(false)
  }
  const calls = await profile.mockCalls('codex')
  expect(calls.filter((call) => call.method === 'thread/read')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
})

test('typed temporary query failure retains only the identified bounded page and source changes invalidate query backoff', async ({
  profile,
}) => {
  const root = mockDirectory(profile.root, 'codex')
  await mkdir(root, { recursive: true })
  const source = join(root, 'retained-source')
  await writeFile(source, '')
  await utimes(source, 1700000000, 1700000000)
  await writeFile(join(root, 'history-mode.json'), JSON.stringify({ historyMode: 'paginated', path: source }))
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, 'Hello world')
  await waitForIdle(profile, conversationId)
  const first = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 1 })
  const request = { conversation_id: conversationId, snapshot: first.snapshot, max_items: 1 }
  const retained = await profile.call('conversation.history', request)
  expect(retained.error).toBeNull()
  const before = (await profile.mockCalls('codex')).filter((call) => effects[call.method])
  await writeFile(
    join(root, 'history-failure.json'),
    JSON.stringify({ code: -32000, message: 'Native quota refused query', data: { code: 'rate_limited' } }),
  )
  const stale = await profile.call('conversation.history', request)
  expect(stale.error?.code).toBe('rate_limited')
  expect(stale.stale).toBe(true)
  expect(stale.complete).toBe(false)
  expect(stale.messages).toEqual(retained.messages)
  expect(stale.snapshot).toEqual(retained.snapshot)
  expect(stale.retained_bytes).toBe(Buffer.byteLength(JSON.stringify(stale.messages)))
  const reads = (await profile.mockCalls('codex')).filter((call) => call.method === 'thread/read').length
  expect(await profile.call('conversation.history', request)).toEqual(stale)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'thread/read')).toHaveLength(reads)
  await writeFile(source, 'changed')
  await utimes(source, 1700000000, 1700000000)
  const changed = await profile.call('conversation.history', request)
  expect(changed.error?.code).toBe('rate_limited')
  expect(changed.stale).toBe(false)
  expect(changed.complete).toBe(false)
  expect(changed.messages).toEqual([])
  expect((await profile.mockCalls('codex')).filter((call) => effects[call.method])).toEqual(before)
})
