import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ReplayCapture,
  Tools,
  TurnMapper,
  fit,
  negotiate,
  permissionOutcome,
  permissionRequest,
  promptBlocks,
} from './normalize.mjs'

const available = (descriptor) =>
  descriptor.capabilities.filter((capability) => capability.available).map((capability) => capability.name)
const operation = (descriptor, method) => descriptor.operations.find((entry) => entry.method === method)

test('capabilities and operations come only from what the agent declared', () => {
  const minimal = negotiate({ name: 'A', init: { protocolVersion: 1 } })
  assert.equal(minimal.problem, null)
  assert.deepEqual(available(minimal.descriptor), ['streaming', 'cancel', 'tool_approval'])
  assert.equal(operation(minimal.descriptor, 'open').availability, 'available')
  assert.equal(operation(minimal.descriptor, 'steer').availability, 'unsupported')
  assert.equal(operation(minimal.descriptor, 'history').availability, 'unsupported')
  assert.deepEqual(minimal.descriptor.native_peer, {
    protocol: 'acp',
    protocol_version: 1,
    features: [],
    auth_methods: [],
  })

  const full = negotiate({
    name: 'B',
    init: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { resume: {}, close: {}, list: {} },
      },
      authMethods: [{ id: 'agent-login', name: 'Log in' }],
      agentInfo: { name: 'sample', version: '2.1.0' },
    },
  })
  assert.deepEqual(available(full.descriptor), [
    'streaming',
    'cancel',
    'tool_approval',
    'images',
    'text_attachments',
    'resume',
  ])
  assert.deepEqual(full.descriptor.native_peer, {
    protocol: 'acp',
    protocol_version: 1,
    name: 'sample',
    version: '2.1.0',
    features: [
      'load_session',
      'resume_session',
      'close_session',
      'list_sessions',
      'prompt_image',
      'prompt_audio',
      'prompt_embedded_context',
      'mcp_http',
    ],
    auth_methods: ['agent-login'],
  })
  // A non-boolean flag is not a declaration.
  assert.equal(
    negotiate({ name: 'C', init: { protocolVersion: 1, agentCapabilities: { loadSession: 'yes' } } }).features.has(
      'load_session',
    ),
    false,
  )
})

test('a version mismatch or failed negotiation leaves open and send unavailable with the reason', () => {
  for (const [input, reason] of [
    [{ init: { protocolVersion: 2 } }, /speaks protocol version 2; ADE's ACP client speaks version 1 only/],
    [{ init: null }, /malformed initialize response/],
    [{ init: null, problem: 'The ACP agent did not complete initialize: timeout' }, /did not complete initialize/],
  ]) {
    const { descriptor, problem } = negotiate({ name: 'X', ...input })
    assert.match(problem, reason)
    for (const method of ['open', 'send', 'cancel', 'answer']) {
      assert.equal(operation(descriptor, method).availability, 'unavailable')
      assert.match(operation(descriptor, method).reason, reason)
    }
    assert.equal(operation(descriptor, 'initialize').availability, 'available')
    assert.deepEqual(available(descriptor), [])
  }
  assert.equal(negotiate({ name: 'X', init: { protocolVersion: 2 } }).descriptor.native_peer.protocol_version, 2)
})

test('prompt blocks refuse attachment kinds the agent did not declare instead of degrading them', () => {
  const image = { attachment: { id: 'a', name: 'x.png', media_type: 'image/png', size: 1 }, data: 'AA==' }
  const text = {
    attachment: { id: 'b', name: 'notes.md', media_type: 'text/markdown', size: 2 },
    data: Buffer.from('hi').toString('base64'),
  }
  assert.throws(
    () => promptBlocks('look', [image], new Set()),
    (error) => error.code === 'unsupported',
  )
  assert.throws(
    () => promptBlocks('look', [text], new Set()),
    (error) => error.code === 'unsupported',
  )
  assert.deepEqual(promptBlocks('look', [image, text], new Set(['prompt_image', 'prompt_embedded_context'])), [
    { type: 'text', text: 'look' },
    { type: 'image', mimeType: 'image/png', data: 'AA==' },
    { type: 'resource', resource: { uri: 'attachment:notes.md', mimeType: 'text/markdown', text: 'hi' } },
  ])
})

test('a turn streams by native message ID, keeps tool identity, and ends on the declared stop reason', () => {
  const mapper = new TurnMapper({ session: 's', submission: 'sub', tools: new Tools() })
  const chunk = (text, messageId) => ({
    sessionUpdate: 'agent_message_chunk',
    messageId,
    content: { type: 'text', text },
  })
  assert.equal(mapper.update(chunk('Hel', 'm1'))[0].id, 'msg:m1')
  assert.equal(mapper.update(chunk('lo', 'm1'))[0].id, 'msg:m1')
  const tool = mapper.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'Read',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'a' },
  })
  assert.equal(tool[0].item.id, 'tool:c1')
  assert.equal(tool[0].item.status, 'streaming')
  const done = mapper.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'body' } }],
  })
  assert.deepEqual(done[0].item.content, {
    type: 'tool',
    call_id: 'c1',
    name: 'Read',
    input: { path: 'a' },
    output: 'body',
    is_error: false,
  })
  // Text without a message ID after a tool call starts its own message.
  const after = mapper.update(chunk('Done'))
  assert.match(after[0].id, /^msg:sub:\d+$/)
  assert.deepEqual(mapper.update({ sessionUpdate: 'thought_unknown_kind' }), [])
  assert.deepEqual(mapper.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } }), [])
  const thought = mapper.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } })
  assert.equal(thought[0].kind, 'reasoning')

  const events = mapper.finish({ result: { stopReason: 'end_turn' }, interruptRequested: false })
  assert.deepEqual(
    events.filter((event) => event.type === 'item').map((event) => [event.item.id, event.item.text, event.item.status]),
    [
      ['msg:m1', 'Hello', 'completed'],
      [after[0].id, 'Done', 'completed'],
      [thought[0].id, 'plan', 'completed'],
    ],
  )
  assert.deepEqual(events.at(-1), {
    type: 'finished',
    session: 's',
    submission: 'sub',
    turn: null,
    status: 'completed',
    error: null,
    native_terminal: { stop_reason: 'end_turn', is_error: false },
    interrupt_requested: false,
  })
})

test('stop reasons map to honest statuses; an unknown one is never completed', () => {
  for (const [reason, status] of [
    ['cancelled', 'interrupted'],
    ['max_tokens', 'failed'],
    ['max_turn_requests', 'failed'],
    ['refusal', 'failed'],
    ['something_new', 'unknown'],
  ]) {
    const mapper = new TurnMapper({ session: 's', submission: 'x', tools: new Tools() })
    assert.equal(mapper.finish({ result: { stopReason: reason }, interruptRequested: true }).at(-1).status, status)
  }
  const mapper = new TurnMapper({ session: 's', submission: 'x', tools: new Tools() })
  const failed = mapper.finish({ error: 'refused', interruptRequested: false }).at(-1)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.native_terminal.is_error, true)
})

test('turn text and open tools are bounded', () => {
  const mapper = new TurnMapper({ session: 's', submission: 'x', tools: new Tools() })
  const big = 'x'.repeat(1024 * 1024)
  for (let index = 0; index < 4; index++)
    mapper.update({
      sessionUpdate: 'agent_message_chunk',
      messageId: `m${index}`,
      content: { type: 'text', text: big },
    })
  assert.throws(
    () => mapper.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y' } }),
    (error) => error.code === 'resource_limit',
  )
  const tools = new Tools()
  for (let index = 0; index < 1024; index++) tools.update({ toolCallId: `t${index}`, status: 'in_progress' }, true)
  assert.throws(
    () => tools.update({ toolCallId: 'over' }, true),
    (error) => error.code === 'resource_limit',
  )
  tools.update({ toolCallId: 't0', status: 'completed' }, false)
  assert.equal(tools.update({ toolCallId: 'over' }, true).id, 'tool:over')
})

test('native JSON past the output frame policy stays readable as truncated text', () => {
  assert.deepEqual(fit({ a: [1, 2] }), { a: [1, 2] })
  const wide = { paths: Array.from({ length: 40 }, (_, index) => index) }
  assert.equal(typeof fit(wide), 'string')
  assert.equal(JSON.parse(fit(wide)).paths.length, 40)
  assert.match(fit({ text: 'x'.repeat(200_000), more: Array.from({ length: 40 }) }), /\[truncated by ADE\]$/)
})

test('replay merges by native identity only, excludes user prompts, and declares every gap', () => {
  const replay = new ReplayCapture('s')
  replay.capture({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hi' } })
  replay.capture({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'hel' } })
  replay.capture({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'lo' } })
  replay.capture({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', status: 'completed' })
  replay.capture({ sessionUpdate: 'usage_update', used: 1, size: 2 })
  assert.deepEqual(
    replay.history({ maxItems: 32, maxBytes: 448 * 1024 }).map((item) => [item.id, item.role, item.text]),
    [
      ['msg:a1', 'assistant', 'hello'],
      ['tool:c1', 'tool', 'ls'],
    ],
  )

  const anonymous = new ReplayCapture('s')
  anonymous.capture({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'no id' } })
  const [notice, ...rest] = anonymous.history({ maxItems: 32, maxBytes: 448 * 1024 })
  assert.equal(rest.length, 0)
  assert.equal(notice.kind, 'notice')
  assert.match(notice.text, /1 replayed updates had no native message ID and were not merged/)

  const long = new ReplayCapture('s')
  for (let index = 0; index < 600; index++)
    long.capture({
      sessionUpdate: 'agent_message_chunk',
      messageId: `m${index}`,
      content: { type: 'text', text: `t${index}` },
    })
  const page = long.history({ maxItems: 32, maxBytes: 448 * 1024 })
  assert.equal(page.length, 32)
  assert.equal(page[0].kind, 'notice')
  assert.match(page[0].text, /481 older replayed items exceed the history page/)
  assert.match(page[0].text, /88 replayed updates exceeded the replay capture bound/)
  assert.equal(page.at(-1).id, 'msg:m511')
})

test('a permission keeps the agent option IDs as answer values and refuses any other value', () => {
  const params = {
    sessionId: 's',
    toolCall: { toolCallId: 'c1', title: 'Write' },
    options: [
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'once', name: 'Once', kind: 'allow_once' },
      { optionId: 'no', name: 'No', kind: 'reject_once' },
    ],
  }
  const request = permissionRequest({ id: 'agent-1', session: 's', submission: 'sub', params })
  assert.deepEqual(request.metadata.schema.choices, [
    { value: 'always', label: 'Always', scope: 'persistent' },
    { value: 'once', label: 'Once', scope: 'once' },
    { value: 'no', label: 'No', scope: 'once' },
  ])
  assert.equal(request.metadata.native_item_id, 'c1')
  assert.deepEqual(permissionOutcome(params.options, { kind: 'choice', value: 'always' }), {
    outcome: { outcome: 'selected', optionId: 'always' },
  })
  assert.throws(
    () => permissionOutcome(params.options, { kind: 'choice', value: 'accept' }),
    (error) => error.code === 'invalid_request',
  )
  assert.throws(
    () => permissionOutcome(params.options, { kind: 'questions', answers: {} }),
    (error) => error.code === 'invalid_request',
  )
})
