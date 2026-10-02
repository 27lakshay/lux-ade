import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorker } from './worker-test-support.mjs'

async function fixture(run, options) {
  const worker = startWorker(options)
  try {
    assert.equal((await worker.initialize()).error, undefined)
    const opened = await worker.open()
    assert.equal(opened.error, undefined)
    await run(worker, opened.result.session)
  } finally {
    await worker.close()
  }
}
const finished = (worker, submission) =>
  worker.wait((events) => events.find((event) => event.type === 'finished' && event.submission === submission))
const request = (worker) => worker.wait((events) => events.find((event) => event.type === 'request'))
const answer = (worker, id) =>
  worker.rpc('answer', {
    id,
    operation_id: 'answer-operation',
    answer: { kind: 'choice', value: { kind: 'claude_permission', decision: 'allow_once' } },
  })

test('native text deltas assemble one row and final assistant replaces that row', async () => {
  await fixture(async (worker, session) => {
    assert.equal((await worker.send(session, 'stream')).error, undefined)
    await finished(worker, 'stream')
    const rows = new Map()
    for (const event of worker.events()) {
      if (event.type === 'delta') rows.set(event.id, (rows.get(event.id) ?? '') + event.text)
      else if (event.type === 'item' && event.item.role === 'assistant') rows.set(event.item.id, event.item.text)
    }
    assert.deepEqual([...rows], [['native-text:0', 'Hello world']])
    assert.ok(
      worker
        .events()
        .filter((event) => event.type === 'delta')
        .every((event) => event.submission === 'stream'),
    )
  })
})

test('foreign output remains visible without settling or acquiring current input identity', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'foreign')
    await finished(worker, 'foreign')
    const foreign = worker.events().find((event) => event.type === 'item' && event.item.id === 'native-foreign:0')
    assert.equal(foreign.item.text, 'autonomous output')
    assert.equal(foreign.submission, null)
    assert.equal(foreign.item.client_id, null)
    assert.deepEqual(
      worker
        .events()
        .filter((event) => event.type === 'finished')
        .map((event) => event.submission),
      ['foreign'],
    )
    assert.equal((await worker.send(session, 'next')).error, undefined)
    await finished(worker, 'next')
  })
})

test('user echo, assistant, tool call and result keep distinct durable row identities', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'rows', 'submission-rows', 'durable-user-message')
    await finished(worker, 'submission-rows')
    const rows = new Map()
    for (const event of worker.events())
      if (event.type === 'item') rows.set(event.item.client_id ?? event.item.id, event.item)
    assert.equal(rows.get('durable-user-message')?.text, 'rows')
    assert.equal(rows.get('native-answer:0')?.text, 'Distinct answer')
    assert.equal(rows.get('native-call')?.content.name, 'Read')
    assert.equal(rows.get('native-call:result')?.text, 'file contents')
    assert.equal(rows.size, 4)
    assert.ok([...rows.values()].filter((row) => row.role !== 'user').every((row) => row.client_id === null))
  })
})

test('native permission before observed input/tool ownership stays session-scoped and answerable', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'callback-before-echo')
    const pending = await request(worker)
    assert.equal(pending.submission, null)
    assert.equal(pending.session, session)
    assert.equal(pending.metadata.native_callback_id, 'native-tool')
    assert.equal(pending.metadata.native_item_id, 'native-tool')
    assert.equal(pending.metadata.native_request_id, 'native-request')
    assert.notEqual(pending.id, pending.metadata.native_callback_id)
    assert.equal((await answer(worker, pending.id)).error, undefined)
    await finished(worker, 'callback-before-echo')
  })
})

test('old autonomous callback cannot acquire a new queued submission', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'old-autonomous-source')
    await finished(worker, 'old-autonomous-source')
    await worker.send(session, 'autonomous-callback-before-echo')
    const pending = await request(worker)
    assert.equal(pending.metadata.native_callback_id, 'native-old-autonomous')
    assert.equal(pending.submission, null)
    assert.equal(pending.session, session)
    assert.equal(
      worker
        .events()
        .some((event) => event.type === 'submitted' && event.submission === 'autonomous-callback-before-echo'),
      false,
    )
    assert.equal((await answer(worker, pending.id)).error, undefined)
    assert.equal((await finished(worker, 'autonomous-callback-before-echo')).status, 'completed')
  })
})

test('observed native tool owner associates its permission callback with the exact input', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'callback-observed-owner')
    const pending = await request(worker)
    assert.equal(pending.metadata.native_callback_id, 'native-owned-tool')
    assert.equal(pending.metadata.native_request_id, 'native-owned-request')
    assert.equal(pending.submission, 'callback-observed-owner')
    assert.equal((await answer(worker, pending.id)).error, undefined)
    assert.equal((await finished(worker, 'callback-observed-owner')).status, 'completed')
  })
})

test('matching admission can interrupt a native callback before its user echo, without accepting a stale attempt', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'callback-before-echo')
    const pending = await request(worker)
    const cancel = (source_attempt_id) =>
      worker.rpc('cancel', { session, turn: null, source_attempt_id, submission_id: 'callback-before-echo' })
    assert.equal((await cancel('stale-attempt')).error?.data.code, 'invalid_request')
    assert.equal((await cancel('attempt')).error, undefined)
    const terminal = await finished(worker, 'callback-before-echo')
    assert.equal(terminal.status, 'cancelled')
    assert.equal(terminal.native_terminal.terminal_reason, 'aborted_tools')
    assert.equal(terminal.interrupt_requested, true)
    assert.deepEqual(
      worker
        .events()
        .filter((event) => event.type === 'resolved')
        .map((event) => event.id),
      [pending.metadata.native_request_id],
    )
    assert.equal((await answer(worker, pending.id)).error?.data.code, 'invalid_request')
  })
})

test('open rejects resume identity mismatch before returning Connected', async () => {
  const worker = startWorker({ env: { CLAUDE_WORKER_SCENARIO: 'resume-mismatch' } })
  try {
    await worker.initialize()
    const response = await worker.open('requested-native-session')
    assert.equal(response.error?.data.code, 'provider_failure')
    assert.match(response.error?.data.message, /different native session identity/)
    assert.equal(response.result, undefined)
    assert.equal(worker.events().filter((event) => event.type === 'started').length, 0)
  } finally {
    await worker.close()
  }
})

test('open propagates native initialization refusal', async () => {
  const worker = startWorker({ env: { CLAUDE_WORKER_SCENARIO: 'init-failure' } })
  try {
    await worker.initialize()
    assert.equal((await worker.open()).error?.data.code, 'provider_failure')
  } finally {
    await worker.close()
  }
})

test('answer removes abort listener and settles callback exactly once', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'callback-answer-abort')
    const pending = await request(worker)
    assert.equal((await answer(worker, pending.id)).error, undefined)
    await finished(worker, 'callback-answer-abort')
    assert.deepEqual(
      worker.events().filter((event) => event.type === 'resolved'),
      [],
    )
    assert.equal((await answer(worker, pending.id)).error?.data.code, 'invalid_request')
  })
})

test('native abort withdraws pending callback and refuses later answer', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'callback-withdraw')
    const pending = await request(worker)
    await finished(worker, 'callback-withdraw')
    assert.deepEqual(
      worker
        .events()
        .filter((event) => event.type === 'resolved')
        .map((event) => event.resolution),
      ['withdrawn'],
    )
    const withdrawal = worker.events().find((event) => event.type === 'resolved')
    assert.equal(withdrawal.id, pending.metadata.native_request_id)
    assert.equal(withdrawal.session, pending.metadata.native_session_id)
    assert.equal(withdrawal.submission, pending.submission)
    assert.equal((await answer(worker, pending.id)).error?.data.code, 'invalid_request')
  })
})

test('already aborted callback does not publish an outstanding request', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'callback-already-aborted')
    await finished(worker, 'callback-already-aborted')
    assert.deepEqual(
      worker.events().filter((event) => event.type === 'request' || event.type === 'resolved'),
      [],
    )
  })
})

test('oversized native item fails explicitly before event serialization or enqueue', async () => {
  const worker = startWorker({ limits: { max_output_frame_bytes: 2048 } })
  try {
    await worker.initialize()
    const session = (await worker.open()).result.session
    await worker.send(session, 'overflow')
    const exit = await worker.exited
    assert.notEqual(exit.code, 0)
    assert.match(worker.diagnostics(), /resource_limit/)
    assert.ok(!worker.events().some((event) => event.type === 'item' && event.item.id === 'native-overflow:0'))
  } finally {
    await worker.close()
  }
})

test('pre-open MCP configuration reaches native query and late configuration is rejected', async () => {
  const worker = startWorker()
  try {
    await worker.initialize()
    const servers = {
      local: { command: 'node', args: ['mcp.mjs'] },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    }
    assert.equal((await worker.rpc('configure_mcp', { servers })).error, undefined)
    const session = (await worker.open()).result.session
    await worker.send(session, 'mcp')
    await finished(worker, 'mcp')
    const message = worker.events().find((event) => event.type === 'item' && event.item.role === 'assistant')
    assert.deepEqual(JSON.parse(message.item.text), servers)
    assert.equal((await worker.rpc('configure_mcp', { servers: {} })).error?.data.code, 'unsupported')
  } finally {
    await worker.close()
  }
})

test('interrupt receipt does not relabel a native execution failure or discard trailing output', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'interrupt')
    await worker.wait((events) =>
      events.find((event) => event.type === 'submitted' && event.submission === 'interrupt'),
    )
    const cancel = (params) =>
      worker.rpc('cancel', { session, turn: null, source_attempt_id: 'attempt', submission_id: 'interrupt', ...params })
    assert.equal((await cancel({ submission_id: 'stale' })).error?.data.code, 'invalid_request')
    const interruption = await cancel({})
    assert.equal(interruption.error, undefined)
    assert.equal(interruption.result.type, 'cancel_result')
    assert.equal(interruption.result.evidence.scope, 'turn')
    assert.equal(interruption.result.evidence.termination, 'requested')
    assert.equal(interruption.result.evidence.active_work_remaining, null)
    assert.equal(interruption.result.evidence.queued_work_count, null)
    assert.equal(interruption.result.evidence.background_work_remaining, null)
    const terminal = await finished(worker, 'interrupt')
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.error, 'Native API failure after interrupt')
    assert.equal(terminal.interrupt_requested, true)
    assert.equal(terminal.native_terminal.subtype, 'error_during_execution')
    assert.equal(terminal.native_terminal.terminal_reason, 'api_error')
    assert.equal(
      worker.events().find((event) => event.type === 'item' && event.item.id === 'native-trailing:0').item.text,
      'after interrupt',
    )
  })
})

const historyContext = {
  provider: 'claude',
  execution_id: 'test',
  account_id: null,
  invalidation_epoch: 0,
  lineage: null,
}
const historyRequest = {
  session: 'history-session',
  context: historyContext,
  snapshot: null,
  cursor: null,
  max_items: 1,
  max_bytes: 4096,
}
async function nativeHistoryFixture(history, run) {
  const worker = startWorker({ env: { CLAUDE_WORKER_HISTORY: JSON.stringify(history) } })
  try {
    await worker.initialize()
    await run(worker)
  } finally {
    await worker.close()
  }
}
test('native history cursor resumes within a multi-block message without duplicating or exposing thinking', async () => {
  await nativeHistoryFixture(
    {
      'history-session': [
        { type: 'user', uuid: 'native-prompt', message: { content: [{ type: 'text', text: 'prompt' }] } },
        {
          type: 'assistant',
          uuid: 'native-envelope',
          message: {
            id: 'native-api-message',
            content: [
              { type: 'text', text: 'one' },
              { type: 'thinking', thinking: 'private' },
              { type: 'text', text: 'two' },
            ],
          },
        },
      ],
    },
    async (worker) => {
      const first = (await worker.rpc('history', historyRequest)).result
      assert.deepEqual(
        first.items.map((item) => item.id),
        ['native-prompt'],
      )
      const second = (
        await worker.rpc('history', { ...historyRequest, snapshot: first.snapshot, cursor: first.next_cursor })
      ).result
      assert.deepEqual(
        second.items.map((item) => [item.id, item.text]),
        [['native-api-message:0', 'one']],
      )
      const third = (
        await worker.rpc('history', { ...historyRequest, snapshot: first.snapshot, cursor: second.next_cursor })
      ).result
      assert.deepEqual(
        third.items.map((item) => [item.id, item.text]),
        [['native-api-message:2', 'two']],
      )
      assert.equal(third.complete, true)
      assert.equal(third.next_cursor, null)
      assert.deepEqual(third.items[0].native_message, {
        provider: 'claude',
        session: 'history-session',
        message_id: 'native-envelope',
      })
      const moved = JSON.parse(Buffer.from(second.next_cursor, 'base64url').toString('utf8'))
      moved.message = 'different-native-message'
      const response = await worker.rpc('history', {
        ...historyRequest,
        snapshot: first.snapshot,
        cursor: Buffer.from(JSON.stringify(moved)).toString('base64url'),
      })
      assert.equal(response.error?.data.code, 'invalid_request')
    },
  )
})
test('native history fails an oversized item explicitly without advancing a cursor', async () => {
  await nativeHistoryFixture(
    {
      'history-session': [
        {
          type: 'assistant',
          uuid: 'native-envelope',
          message: { id: 'native-api-message', content: [{ type: 'text', text: 'x'.repeat(8192) }] },
        },
      ],
    },
    async (worker) => {
      const response = await worker.rpc('history', historyRequest)
      assert.equal(response.error, undefined)
      assert.equal(response.result.error.code, 'resource_limit')
      assert.deepEqual(response.result.items, [])
      assert.equal(response.result.next_cursor, null)
      assert.equal(response.result.complete, false)
    },
  )
})
test('child transcript verifies membership and pages native messages while omitting private reasoning', async () => {
  const messages = Array.from({ length: 51 }, (_, index) => ({
    type: 'assistant',
    uuid: 'child-message-' + index,
    message: {
      content: [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'visible-' + index },
      ],
    },
  }))
  await nativeHistoryFixture({ 'history-session/child-native': messages }, async (worker) => {
    const request = { session: 'history-session', child: 'child-native', cursor: null, offset: 0 }
    const response = await worker.rpc('child_transcript', request)
    assert.equal(response.error, undefined, JSON.stringify(response))
    const first = response.result
    assert.deepEqual(
      first.items.map((item) => item.text),
      Array.from({ length: 32 }, (_, index) => 'visible-' + index),
    )
    assert.equal(first.next_offset, 32)
    const second = (
      await worker.rpc('child_transcript', { ...request, offset: first.next_offset, cursor: first.next_cursor })
    ).result
    assert.deepEqual(
      second.items.map((item) => item.text),
      Array.from({ length: 19 }, (_, index) => 'visible-' + (index + 32)),
    )
    assert.equal(second.next_offset, null)
    assert.equal(
      (await worker.rpc('child_transcript', { ...request, child: 'foreign-child' })).error?.data.code,
      'invalid_request',
    )
    assert.equal(
      (await worker.rpc('child_transcript', { ...request, child: '../escape' })).error?.data.code,
      'invalid_request',
    )
  })
})

test('native child lifecycle keeps one card, native task/tool fences, and no fabricated native turn', async () => {
  await fixture(async (worker, session) => {
    await worker.send(session, 'child-lifecycle')
    await finished(worker, 'child-lifecycle')
    const cards = worker.events().filter((event) => event.type === 'item' && event.item.kind === 'subagent')
    assert.deepEqual(
      cards.map((event) => event.item.content.agents[0].state),
      ['running', 'running', 'completed'],
    )
    assert.equal(new Set(cards.map((event) => event.item.id)).size, 1)
    assert.ok(
      cards.every(
        (event) => event.submission === 'child-lifecycle' && event.item.turn === null && event.item.client_id === null,
      ),
    )
    assert.equal(cards.at(-1).item.content.agents[0].id, 'native-child')
    assert.ok(
      !worker.events().some((event) => event.type === 'item' && event.item.text === 'Child transcript stays separate'),
    )
  })
})

test('child block cursors traverse every visible block of one thousand-block native message under the 32-item cap', async () => {
  const blocks = Array.from({ length: 1000 }, (_, index) => ({ type: 'text', text: 'block-' + index }))
  await nativeHistoryFixture(
    {
      'history-session/child-native': [
        { type: 'assistant', uuid: 'native-child-envelope', message: { content: blocks } },
      ],
    },
    async (worker) => {
      const all = []
      let offset = 0,
        cursor = null
      do {
        const response = await worker.rpc('child_transcript', {
          session: 'history-session',
          child: 'child-native',
          offset,
          cursor,
        })
        assert.equal(response.error, undefined, JSON.stringify(response))
        assert.ok(response.result.items.length <= 32)
        assert.ok(Buffer.byteLength(JSON.stringify(response.result)) < 512 * 1024)
        all.push(...response.result.items.map((item) => [item.id, item.text]))
        offset = response.result.next_offset
        cursor = response.result.next_cursor
        if (cursor) assert.equal(offset, 0)
      } while (cursor)
      assert.deepEqual(
        all,
        Array.from({ length: 1000 }, (_, index) => ['native-child-envelope:' + index, 'block-' + index]),
      )
      assert.equal(offset, null)
    },
  )
})
