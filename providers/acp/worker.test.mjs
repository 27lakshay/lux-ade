// The ACP worker against the deterministic fixture agent, over the real provider worker protocol.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentCalls, stageFixture, startWorker } from './worker-peer.mjs'

const config = { permission_mode: 'default', model: null, setting_sources: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function openWorker(env = {}, resume = null, staged) {
  const fixture = staged ?? (await stageFixture())
  const worker = startWorker({ command: fixture.command, env: { ACP_FIXTURE_DIR: fixture.dir, ...env } })
  const descriptor = await worker.initialize()
  const opened = await worker.request('open', { resume, config })
  return { fixture, worker, descriptor, opened }
}

const sendText = (worker, session, submission, text) =>
  worker.request('send', { session, source_attempt_id: 'attempt', submission, message_id: null, text, attachments: [] })

test('startup output and output after a reply belong to no turn', async () => {
  const { worker, opened } = await openWorker()
  try {
    assert.deepEqual(await sendText(worker, opened.session, 's1', 'late please'), {
      admitted: true,
      dispatch: 'dispatched',
      native_outcome: 'pending',
      turn: null,
    })
    await worker.waitFor((event) => event.type === 'finished' && event.submission === 's1')
    await sendText(worker, opened.session, 's2', 'hello')
    await worker.waitFor((event) => event.type === 'finished' && event.submission === 's2')
    const texts = worker
      .events()
      .filter((event) => event.type === 'delta')
      .map((event) => [event.submission, event.text])
    assert.deepEqual(texts, [
      ['s1', 'Hello '],
      ['s1', 'ACP'],
      ['s2', 'Hello '],
      ['s2', 'ACP'],
    ])
    // Started is bound before any update of its prompt, and acceptance comes from native evidence.
    const kinds = worker
      .events()
      .filter((event) => event.submission === 's2')
      .map((event) => event.type)
    assert.deepEqual(kinds.slice(0, 3), ['started', 'submitted', 'delta'])
  } finally {
    await worker.stop()
  }
})

test('session/load replay is captured before its reply; output after the reply is live, not history', async () => {
  const first = await openWorker()
  await sendText(first.worker, first.opened.session, 's1', 'hello')
  await first.worker.waitFor((event) => event.type === 'finished')
  await first.worker.stop()
  const second = await openWorker({}, first.opened.session, first.fixture)
  try {
    assert.equal(second.opened.session, first.opened.session)
    assert.deepEqual(
      second.opened.history.map((item) => [item.id, item.role, item.text]),
      [['msg:a-1', 'assistant', 'Hello ACP']],
    )
    await sleep(100)
    // "after load" arrived after the load reply with no prompt open: it reached no turn.
    assert.equal(
      second.worker.events().some((event) => event.type === 'delta'),
      false,
    )
    assert.deepEqual((await agentCalls(first.fixture.dir)).map((call) => call.method).filter(Boolean), [
      'initialize',
      'session/new',
      'session/prompt',
      'initialize',
      'session/load',
    ])
  } finally {
    await second.worker.stop()
  }
})

test('an agent that declares resume is resumed without replay', async () => {
  const first = await openWorker({ ACP_FIXTURE_RESUME: '1' })
  await first.worker.stop()
  const second = await openWorker({ ACP_FIXTURE_RESUME: '1' }, first.opened.session, first.fixture)
  try {
    assert.deepEqual(second.opened.history, [])
    const methods = (await agentCalls(first.fixture.dir)).map((call) => call.method).filter(Boolean)
    assert.ok(methods.includes('session/resume'))
    assert.ok(!methods.includes('session/load'))
  } finally {
    await second.worker.stop()
  }
})

test('Stop answers the open permission as cancelled, sends session/cancel, and the reply settles the turn', async () => {
  const { worker, opened, fixture } = await openWorker()
  try {
    await sendText(worker, opened.session, 's1', 'permission please')
    const request = await worker.waitFor((event) => event.type === 'request')
    assert.equal(request.submission, 's1')
    assert.deepEqual(
      request.metadata.schema.choices.map((choice) => choice.value),
      ['allow-once', 'allow-always', 'reject-once'],
    )
    // An answer naming an option the agent never offered is refused, and nothing reaches the agent.
    await assert.rejects(
      worker.request('answer', { id: request.id, operation_id: 'o1', answer: { kind: 'choice', value: 'accept' } }),
    )
    // A cancellation for another submission is refused rather than applied to this prompt.
    await assert.rejects(
      worker.request('cancel', { session: opened.session, source_attempt_id: 'attempt', submission_id: 'other' }),
    )
    const cancelled = await worker.request('cancel', {
      session: opened.session,
      source_attempt_id: 'attempt',
      submission_id: 's1',
    })
    assert.deepEqual(cancelled.evidence, {
      scope: 'turn',
      interruption_requested: true,
      termination: 'requested',
      active_work_remaining: null,
      queued_work_count: 0,
      background_work_remaining: null,
      observed_at_ms: null,
    })
    const finished = await worker.waitFor((event) => event.type === 'finished')
    assert.equal(finished.status, 'interrupted')
    assert.equal(finished.interrupt_requested, true)
    assert.equal(finished.native_terminal.stop_reason, 'cancelled')
    const order = worker.events().map((event) => event.type)
    assert.ok(order.indexOf('resolved') < order.indexOf('finished'))
    const calls = await agentCalls(fixture.dir)
    assert.deepEqual(
      calls.filter((call) => call.method === undefined).map((call) => call.result),
      [{ outcome: { outcome: 'cancelled' } }],
    )
    assert.equal(calls.filter((call) => call.method === 'session/cancel').length, 1)
  } finally {
    await worker.stop()
  }
})

test('an orderly shutdown closes a declared session/close, otherwise cancels, and never settles the prompt', async () => {
  for (const [env, method] of [
    [{ ACP_FIXTURE_CLOSE: '1' }, 'session/close'],
    [{}, 'session/cancel'],
  ]) {
    const { worker, opened, fixture } = await openWorker(env)
    await sendText(worker, opened.session, 's1', 'hold on')
    await sleep(100)
    assert.equal(await worker.stop(), 0)
    const methods = (await agentCalls(fixture.dir)).map((call) => call.method)
    assert.ok(methods.includes(method), JSON.stringify({ method, methods }))
    assert.equal(
      worker.events().some((event) => event.type === 'finished'),
      false,
    )
  }
})

test('an agent exit ends the worker with the running prompt unsettled', async () => {
  const { worker, opened } = await openWorker()
  await sendText(worker, opened.session, 's1', 'crash now')
  const code = await Promise.race([worker.exited, sleep(10_000).then(() => 'timeout')])
  assert.notEqual(code, 'timeout')
  assert.notEqual(code, 0)
  assert.equal(
    worker.events().some((event) => event.type === 'finished'),
    false,
  )
  assert.match(worker.stderr(), /The ACP agent exited with status 7/)
})

test('another ACP version is reported in the descriptor and nothing opens', async () => {
  const fixture = await stageFixture()
  const worker = startWorker({
    command: fixture.command,
    env: { ACP_FIXTURE_DIR: fixture.dir, ACP_FIXTURE_PROTOCOL: '2' },
  })
  try {
    const descriptor = await worker.initialize()
    const open = descriptor.operations.find((operation) => operation.method === 'open')
    assert.equal(open.availability, 'unavailable')
    assert.match(open.reason, /speaks protocol version 2/)
    assert.equal(descriptor.native_peer.protocol_version, 2)
    await assert.rejects(worker.request('open', { resume: null, config }))
    assert.deepEqual(
      (await agentCalls(fixture.dir)).map((call) => call.method),
      ['initialize'],
    )
  } finally {
    await worker.stop()
  }
})

test('an executable that does not speak ACP is reported before any session', async () => {
  const worker = startWorker({ command: '/bin/cat' })
  try {
    const descriptor = await worker.initialize()
    const send = descriptor.operations.find((operation) => operation.method === 'send')
    assert.equal(send.availability, 'unavailable')
    assert.match(send.reason, /did not complete initialize/)
  } finally {
    await worker.stop()
  }
})
