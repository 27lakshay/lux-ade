// The OpenCode engine against an in-memory session API: projection, requests,
// admission, cancellation evidence and recovery, without a server process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCodeEngine } from '../src/native/engine.mjs'

class Provider {
  constructor() {
    this.log = []
    this.history = []
    this.eventsQueue = []
    this.wake = null
    this.streams = 0
    this.state = { inbox: [], permissions: [], forms: [], active: false }
  }
  emit(type, data = {}) {
    this.eventsQueue.push({
      id: `evt_${this.log.length}_${Math.random()}`,
      type,
      data: { sessionID: 'ses_test', ...data },
    })
    this.wake?.()
  }
  async *events({ signal }) {
    this.streams++
    yield { type: 'server.connected', data: {} }
    while (!signal.aborted) {
      if (this.eventsQueue.length) {
        const event = this.eventsQueue.shift()
        if (event.type === 'disconnect') throw new Error('Connection lost')
        yield event
        continue
      }
      await new Promise((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done)
          this.wake = null
          resolve()
        }
        this.wake = done
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
  }
  async request(method, path) {
    this.log.push(['request', method, path])
    const id = decodeURIComponent(path.split('/').at(-1))
    if (this.history.some((message) => message.id === id)) return { data: {} }
    throw Object.assign(new Error('missing'), { status: 404 })
  }
  async open() {
    return { id: 'ses_test' }
  }
  async *messages(session, { order }) {
    yield* structuredClone(order === 'desc' ? [...this.history].reverse() : this.history)
  }
  async pending() {
    return structuredClone(this.state)
  }
  async submit(session, input) {
    this.log.push(['submit', input])
    this.state.active = true
    this.history.push({ id: input.id, type: 'user', text: input.text, metadata: { ade_submission: input.submission } })
    return { id: input.id, sessionID: session }
  }
  async permission(session, id, decision) {
    this.log.push(['permission', id, decision])
    this.state.permissions = []
  }
  async form(session, id, answers) {
    this.log.push(['form', id, answers])
    this.state.forms = []
  }
  async cancelQueued(session, id) {
    this.log.push(['cancelQueued', id])
    this.state.inbox = this.state.inbox.filter((item) => item.id !== id)
  }
  async interrupt() {
    this.log.push(['interrupt'])
    this.state.active = false
    return { interrupted: true }
  }
  async resumeQueued(session, id) {
    this.log.push(['resumeQueued', id])
    this.state.inbox = []
    this.state.active = true
  }
  async stop() {
    this.log.push(['stop'])
  }
}

async function setup(provider = new Provider()) {
  const output = []
  const engine = new OpenCodeEngine((event) => output.push(event), {
    cwd: '/fixture',
    connect: async () => ({ transport: provider, api: provider }),
  })
  await engine.open({ config: {} })
  return { provider, engine, output }
}
async function wait(check) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await delay(10)
  }
  throw new Error('Timed out')
}
const send = (engine, message = 'one') =>
  engine.send({
    session: 'ses_test',
    source_attempt_id: 'attempt',
    submission: `ade_${message}`,
    message_id: message,
    text: 'hello',
    attachments: [],
  })

test('a send derives its native ID from the ADE message, streams text and finishes only on durable idle', async () => {
  const { provider, engine, output } = await setup()
  try {
    assert.deepEqual(await send(engine), {
      turn: 'msg_one',
      admitted: true,
      dispatch: 'dispatched',
      native_outcome: 'accepted',
    })
    assert.equal(provider.log.find((entry) => entry[0] === 'submit')[1].id, 'msg_one')
    const data = { assistantMessageID: 'msg_answer', ordinal: 0 }
    provider.emit('session.text.started', data)
    provider.emit('session.text.delta', { ...data, delta: 'hello' })
    provider.emit('session.text.ended', { ...data, text: 'hello' })
    provider.history.push({
      id: 'msg_answer',
      type: 'assistant',
      time: { completed: 1 },
      content: [{ type: 'text', text: 'hello' }],
    })
    await wait(() => output.some((event) => event.type === 'delta'))
    assert.equal(output.find((event) => event.type === 'delta').submission, 'ade_one')
    await engine.refresh()
    assert.equal(
      output.some((event) => event.type === 'finished'),
      false,
    )
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'succeeded' })
    provider.state.active = false
    await engine.refresh()
    const finished = output.filter((event) => event.type === 'finished')
    assert.equal(finished.length, 1)
    assert.deepEqual(
      { turn: finished[0].turn, submission: finished[0].submission, status: finished[0].status },
      { turn: 'msg_one', submission: 'ade_one', status: 'completed' },
    )
    assert.deepEqual(finished[0].native_terminal, { terminal_reason: 'idle.succeeded', is_error: false })
    assert.equal(output.find((event) => event.type === 'item' && event.item.role === 'user').item.client_id, 'ade_one')
  } finally {
    await engine.close()
  }
})

test('a send without a durable ADE message identity is refused before OpenCode sees it', async () => {
  const { provider, engine } = await setup()
  try {
    await assert.rejects(engine.send({ session: 'ses_test', submission: 'x', message_id: null, text: 'hi' }), {
      code: 'invalid_request',
    })
    assert.equal(
      provider.log.some((entry) => entry[0] === 'submit'),
      false,
    )
  } finally {
    await engine.close()
  }
})

test('a lost prompt reply is reconciled by reading, never by resending', async () => {
  const { provider, engine } = await setup()
  try {
    const submit = provider.submit.bind(provider)
    provider.submit = async (session, input) => {
      await submit(session, input)
      throw new TypeError('fetch failed')
    }
    assert.equal((await send(engine)).native_outcome, 'accepted')
    assert.equal(provider.log.filter((entry) => entry[0] === 'submit').length, 1)
  } finally {
    await engine.close()
  }
})

test('permissions and questions carry typed schemas, are answered once, and stale answers fail', async () => {
  const { provider, engine, output } = await setup()
  try {
    await send(engine)
    provider.state.permissions = [{ id: 'per_one', action: 'bash', resources: ['echo hello'] }]
    provider.state.forms = [
      { id: 'frm_one', title: 'Choose', fields: [{ key: 'name', type: 'string', title: 'Name' }] },
    ]
    await engine.refresh()
    await engine.refresh()
    const requests = output.filter((event) => event.type === 'request')
    assert.equal(requests.length, 2)
    assert.deepEqual(
      requests[0].metadata.schema.choices.map((choice) => choice.value),
      ['once', 'reject'],
    )
    assert.equal(requests[1].metadata.schema.questions[0].id, 'name')
    await engine.answer({ id: 'per_one', operation_id: 'a', answer: { kind: 'choice', value: 'reject' } })
    await engine.answer({
      id: 'frm_one',
      operation_id: 'b',
      answer: { kind: 'questions', answers: { name: ['Alice'] } },
    })
    await assert.rejects(
      engine.answer({ id: 'per_one', operation_id: 'c', answer: { kind: 'choice', value: 'once' } }),
      {
        code: 'invalid_request',
      },
    )
    assert.deepEqual(
      provider.log.filter((entry) => entry[0] === 'permission').map((entry) => entry[2]),
      ['decline'],
    )
    assert.deepEqual(provider.log.find((entry) => entry[0] === 'form')[2], { name: 'Alice' })
  } finally {
    await engine.close()
  }
})

for (const choice of ['resume', 'cancel']) {
  test(`a parked ADE prompt waits for an explicit ${choice} and is never resubmitted`, async () => {
    const provider = new Provider()
    provider.state.inbox = [
      { id: 'msg_parked', type: 'user', payload: { text: 'parked', metadata: { ade_submission: 'ade_parked' } } },
    ]
    const { engine, output } = await setup(provider)
    try {
      const request = output.find((event) => event.type === 'request')
      assert.equal(request.method, 'opencode/recover')
      assert.deepEqual([request.submission, request.turn], [null, null])
      assert.equal(provider.log.length, 0)
      await assert.rejects(send(engine), { message: /active turn/ })
      await engine.answer({ id: request.id, operation_id: 'op', answer: { kind: 'choice', value: choice } })
      assert.equal(
        provider.log.some((entry) => entry[0] === 'submit'),
        false,
      )
      assert.equal(
        provider.log.some((entry) => entry[0] === (choice === 'resume' ? 'resumeQueued' : 'cancelQueued')),
        true,
      )
      if (choice === 'cancel')
        assert.deepEqual(output.find((event) => event.type === 'finished').native_terminal, {
          terminal_reason: 'inbox.cancelled',
          is_error: false,
        })
    } finally {
      await engine.close()
    }
  })
}

test('reconnect reloads durable completion without replaying the submission', async () => {
  const { provider, engine, output } = await setup()
  try {
    await send(engine)
    provider.emit('disconnect')
    await wait(() => engine.epoch === 1)
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'failed' })
    provider.state.active = false
    await wait(() => provider.streams === 2)
    await wait(() => output.some((event) => event.type === 'finished'))
    assert.equal(output.find((event) => event.type === 'finished').status, 'failed')
    assert.equal(provider.log.filter((entry) => entry[0] === 'submit').length, 1)
  } finally {
    await engine.close()
  }
})

test('simultaneous submissions cannot pass the active-turn guard', async () => {
  const { provider, engine } = await setup()
  try {
    const first = send(engine)
    await assert.rejects(send(engine, 'two'), { message: /active turn/ })
    await first
    assert.equal(provider.log.filter((entry) => entry[0] === 'submit').length, 1)
  } finally {
    await engine.close()
  }
})

test('cancellation reports remaining work as evidence instead of claiming it stopped', async () => {
  const { provider, engine, output } = await setup()
  try {
    await send(engine)
    provider.interrupt = async () => ({ interrupted: false })
    const result = await engine.cancel({ session: 'ses_test', source_attempt_id: 'attempt', submission_id: 'ade_one' })
    assert.deepEqual(result.evidence, {
      scope: 'session',
      interruption_requested: true,
      termination: 'requested',
      active_work_remaining: true,
      queued_work_count: 0,
      background_work_remaining: null,
      observed_at_ms: result.evidence.observed_at_ms,
    })
    assert.equal(
      output.some((event) => event.type === 'finished'),
      false,
    )
    assert.ok(engine.active)
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'interrupted' })
    provider.state.active = false
    await engine.refresh()
    const finished = output.find((event) => event.type === 'finished')
    assert.equal(finished.status, 'interrupted')
    assert.equal(finished.interrupt_requested, true)
  } finally {
    await engine.close()
  }
})

test('a turn that already completed is not relabelled as interrupted by a late cancel', async () => {
  const { provider, engine, output } = await setup()
  try {
    await send(engine)
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'succeeded' })
    provider.state.active = false
    const result = await engine.cancel({ session: 'ses_test', source_attempt_id: 'attempt', submission_id: 'ade_one' })
    assert.equal(result.evidence.termination, 'confirmed')
    assert.equal(output.find((event) => event.type === 'finished').status, 'completed')
    await assert.rejects(
      engine.cancel({ session: 'ses_test', source_attempt_id: 'attempt', submission_id: 'ade_one' }),
      { code: 'invalid_request' },
    )
  } finally {
    await engine.close()
  }
})

test('turns another OpenCode client admits are observed, including approvals and completion', async () => {
  const { provider, engine, output } = await setup()
  try {
    provider.history.push({ id: 'msg_native', type: 'user', text: 'from the TUI' })
    provider.state.active = true
    provider.state.permissions = [{ id: 'per_native', action: 'bash', resources: ['echo native'] }]
    await engine.refresh()
    assert.equal(output.filter((e) => e.type === 'started' && e.turn === 'msg_native').length, 1)
    assert.equal(output.find((e) => e.type === 'item' && e.item.id === 'msg_native').item.text, 'from the TUI')
    assert.equal(output.find((e) => e.type === 'request').turn, 'msg_native')
    await engine.answer({ id: 'per_native', operation_id: 'op', answer: { kind: 'choice', value: 'once' } })
    provider.history.push(
      {
        id: 'msg_answer_native',
        type: 'assistant',
        time: { completed: 1 },
        content: [{ type: 'text', text: 'native response' }],
      },
      { id: 'msg_idle_native', type: 'idle', outcome: 'succeeded' },
    )
    provider.state.active = false
    await engine.refresh()
    await engine.refresh()
    assert.equal(output.filter((e) => e.type === 'finished' && e.turn === 'msg_native').length, 1)
    assert.equal(
      provider.log.some((e) => e[0] === 'submit'),
      false,
    )
  } finally {
    await engine.close()
  }
})

test('a submission racing another client is refused without stopping the shared server', async () => {
  const { provider, engine, output } = await setup()
  try {
    provider.history.push({ id: 'msg_native_race', type: 'user', text: 'native first' })
    provider.state.active = true
    await assert.rejects(send(engine), { message: /another view/ })
    assert.equal(
      provider.log.some((e) => e[0] === 'stop'),
      false,
    )
    assert.equal(
      output.some((e) => e.type === 'exited'),
      false,
    )
    await engine.refresh()
    assert.equal(output.find((e) => e.type === 'started').turn, 'msg_native_race')
  } finally {
    await engine.close()
  }
})

test('history pages are bounded, continue by cursor and refuse a stale cursor', async () => {
  const { provider, engine } = await setup()
  try {
    for (let i = 0; i < 5; i++)
      provider.history.push(
        { id: `msg_u${i}`, type: 'user', text: `prompt ${i}` },
        { id: `msg_a${i}`, type: 'assistant', time: { completed: 1 }, content: [{ type: 'text', text: `reply ${i}` }] },
        { id: `msg_i${i}`, type: 'idle', outcome: 'succeeded' },
      )
    const context = {
      provider: 'plugin:ade.opencode',
      execution_id: 'run',
      account_id: null,
      lineage: null,
      invalidation_epoch: 0,
    }
    const request = { session: 'ses_test', context, snapshot: null, cursor: null, max_items: 4, max_bytes: 524288 }
    const first = await engine.history(request)
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['prompt 0', 'reply 0', 'prompt 1', 'reply 1'],
    )
    assert.equal(first.complete, false)
    const second = await engine.history({ ...request, snapshot: first.snapshot, cursor: first.next_cursor })
    assert.equal(second.items[0].text, 'prompt 2')
    provider.history.push({ id: 'msg_u9', type: 'user', text: 'new' })
    await assert.rejects(engine.history({ ...request, snapshot: first.snapshot, cursor: first.next_cursor }), {
      code: 'invalid_request',
    })
  } finally {
    await engine.close()
  }
})
