// F024 / ticket 20: a conforming ACP peer runs Conversations through the bundled ACP provider
// worker (providers/acp), which speaks ACP through the official SDK. The fixture agent is
// e2e/protocol/fixtures/adapters/acp_agent.mjs; it records every message it receives, so each spec
// can prove what reached the agent and how often.
import {
  answerIntent,
  cancelActiveSubmission,
  choiceAnswer,
  conversationStatus,
  expect,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForMessage,
  waitForPendingRequest,
  type ScratchProfile,
} from '../fixtures'
import { acpCalls, defineAcpAdapter, stageAdapterAgents, type AdapterAgents } from '../fixtures/adapters'

async function prompts(agents: AdapterAgents, text?: string) {
  return (await acpCalls(agents)).filter(
    (call) =>
      call.method === 'session/prompt' && (text === undefined || JSON.stringify(call.params?.prompt).includes(text)),
  )
}

async function methods(agents: AdapterAgents) {
  return (await acpCalls(agents)).map((call) => call.method).filter(Boolean)
}

/** Cancel the running turn: it settles as interrupted and pauses the queue, which is resumed for the next send. */
async function cancelTurn(profile: ScratchProfile, conversationId: string) {
  await cancelActiveSubmission(profile, conversationId)
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
}

/** ACP names no native turn: a running prompt is identified by its ADE attempt and submission. */
async function turnRunning(profile: ScratchProfile, conversationId: string, agents: AdapterAgents, text: string) {
  await expect.poll(async () => (await prompts(agents, text)).length).toBe(1)
  await expect
    .poll(async () => {
      const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
      return conversation.status === 'running' && conversation.runtime_submission !== null
    })
    .toBe(true)
}

async function messages(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages.map(
    (message) => `${message.role}:${message.text}`,
  )
}

/** Crash the agent mid-turn, then resume: a new worker opens the same native session. */
async function crashAndResume(profile: ScratchProfile, conversationId: string, agents: AdapterAgents) {
  await send(profile, conversationId, 'crash now')
  await expect.poll(() => conversationStatus(profile, conversationId)).not.toMatch(/^(starting|running|waiting)$/)
  // The agent exited before any evidence that it took the prompt: its outcome stays unknown, and an
  // implicit resume is refused because the native session may continue that work.
  const crashed = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.role === 'user' && message.text === 'crash now',
  )
  expect(crashed?.delivery).toMatchObject({ dispatch: 'dispatched', native_outcome: 'unknown' })
  expect(crashed?.delivery?.terminal ?? null).toBeNull()
  await expect(profile.call('agent.resume', { conversation_id: conversationId })).rejects.toThrow(
    /continue_interrupted/,
  )
  await profile.call('agent.resume', { conversation_id: conversationId, continue_interrupted: true })
  await waitForIdle(profile, conversationId)
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  expect(await prompts(agents, 'crash now')).toHaveLength(1)
}

test('F024: the ACP worker negotiates before execution, runs a turn, and keeps startup output out of every turn', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents)
  expect(provider).toBe('adapter:e2e-acp')

  // The probe records what the agent negotiated through the worker, and nothing more.
  const record = (await profile.call('adapter.list', {})).adapters.find((adapter) => adapter.provider_id === provider)
  const outcome = record?.probe?.outcome
  if (outcome?.status !== 'ready') throw new Error('The ACP adapter probe did not succeed')
  expect(outcome.worker?.native_peer).toEqual({
    protocol: 'acp',
    protocol_version: 1,
    name: 'e2e-acp',
    version: '1.0.0',
    features: ['load_session'],
    auth_methods: [],
  })
  expect(
    Object.fromEntries(
      (outcome.worker?.operations ?? []).map((operation) => [operation.method, operation.availability]),
    ),
  ).toEqual({
    initialize: 'available',
    open: 'available',
    send: 'available',
    steer: 'unsupported',
    cancel: 'available',
    answer: 'available',
    history: 'unsupported',
    compact: 'unsupported',
    rewind: 'unsupported',
    configure_mcp: 'unsupported',
    child_transcript: 'unsupported',
  })
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.providers.find((descriptor) => descriptor.id === provider)).toEqual({
    id: provider,
    name: 'E2E ACP',
    capabilities: ['streaming', 'cancel', 'tool_approval', 'resume'],
    permission_modes: ['default'],
    setting_sources: [],
  })

  // An unprobed adapter is neither listed nor accepted; a probe makes it both.
  await profile.call('adapter.put', {
    definition: {
      id: 'e2e-unprobed',
      name: 'Unprobed',
      kind: 'acp',
      command: agents.acp,
      env: { ACP_FIXTURE_DIR: agents.dir },
    },
  })
  expect(
    (await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === 'adapter:e2e-unprobed'),
  ).toBe(false)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(
    profile.call('conversation.create', { workspace_id: workspace.id, provider: 'adapter:e2e-unprobed' }),
  ).rejects.toThrow(/not ready; probe it/)
  await expect(
    profile.call('conversation.create', { workspace_id: workspace.id, provider: 'adapter:missing' }),
  ).rejects.toThrow(/No adapter has ID missing/)
  await expect(
    profile.call('conversation.create', {
      workspace_id: workspace.id,
      provider,
      provider_config: { permission_mode: 'plan' },
    }),
  ).rejects.toThrow(/Unsupported permission mode/)
  await expect(
    profile.call('conversation.create', { workspace_id: workspace.id, provider, account_id: 'account_x' }),
  ).rejects.toThrow(/manages no accounts/)

  // The fixture sends "stray startup" text right after session/new, before any prompt exists:
  // it belongs to no turn and never reaches the timeline.
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)
  expect(await messages(profile, conversationId)).toEqual(['user:hello', 'assistant:Hello ACP'])
  expect(await prompts(agents)).toHaveLength(1)
  expect(await methods(agents)).toEqual(expect.arrayContaining(['initialize', 'session/new', 'session/prompt']))
  const { messages: stored } = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(stored.find((message) => message.role === 'user')?.delivery).toMatchObject({
    dispatch: 'dispatched',
    native_outcome: 'accepted',
    terminal: { status: 'completed', correlated: true, native_terminal: { stop_reason: 'end_turn' } },
  })

  // A second turn on the same native session.
  await send(profile, conversationId, 'again')
  await expect.poll(async () => (await messages(profile, conversationId)).length).toBe(4)
  await waitForIdle(profile, conversationId)
  expect(new Set((await prompts(agents)).map((call) => call.params?.sessionId)).size).toBe(1)

  // Another ACP version is refused at probe time with the worker's reason, before any session exists.
  await profile.call('adapter.put', {
    definition: {
      id: 'e2e-v2',
      name: 'V2',
      kind: 'acp',
      command: agents.acp,
      env: { ACP_FIXTURE_DIR: agents.dir, ACP_FIXTURE_PROTOCOL: '2' },
    },
  })
  const refused = await profile.call('adapter.probe', { id: 'e2e-v2' })
  expect(refused.adapter.readiness).toBe('failed')
  expect(JSON.stringify(refused.adapter.probe)).toContain(
    "The ACP agent speaks protocol version 2; ADE's ACP client speaks version 1 only",
  )
  expect((await methods(agents)).filter((method) => method === 'session/new')).toHaveLength(1)
})

test('F024/F028: permission answers keep the agent option IDs, once-only and persistent meanings, and a repeat converges', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents))
  const responses = async () =>
    (await acpCalls(agents))
      .filter((call) => call.method === undefined)
      .map((call) => (call.result as { outcome?: { outcome: string; optionId?: string } } | undefined)?.outcome)

  await send(profile, conversationId, 'permission one')
  const first = await waitForPendingRequest(profile, conversationId)
  expect(await conversationStatus(profile, conversationId)).toBe('waiting')
  const schema = first.metadata.schema
  if (schema.kind !== 'choices') throw new Error('ACP permission did not expose native choices')
  expect(schema.choices.map((choice) => [choice.value, choice.scope])).toEqual([
    ['allow-once', 'once'],
    ['allow-always', 'persistent'],
    ['reject-once', 'once'],
  ])
  expect(first.metadata.native_item_id).toBe('call-1')
  const answer = answerIntent(first, choiceAnswer(first, 'accept'), 'acp-permission-once')
  await profile.call('agent.answer', answer)
  await waitForMessage(profile, conversationId, 'Permission allow-once')
  await waitForIdle(profile, conversationId)
  // The same effect operation converges without a second reply to the peer.
  await profile.call('agent.answer', answer)
  await expect(
    profile.call('agent.answer', answerIntent(first, choiceAnswer(first, 'decline'), 'acp-permission-conflict')),
  ).rejects.toThrow()
  expect(await responses()).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
  // The tool the permission guarded is one identified tool item, completed after the answer.
  const tool = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.provider_item_id === 'tool:call-1',
  )
  expect(tool).toMatchObject({ role: 'tool', status: 'completed', text: 'Write notes.txt' })

  await send(profile, conversationId, 'permission two')
  const second = await waitForPendingRequest(profile, conversationId)
  if (second.metadata.schema.kind !== 'choices') throw new Error('ACP permission did not expose native choices')
  const persistent = second.metadata.schema.choices.find((choice) => choice.value === 'allow-always')
  if (!persistent) throw new Error('ACP persistent native choice is missing')
  const persistentAnswer = answerIntent(
    second,
    { kind: 'choice', value: persistent.value },
    'acp-permission-persistent',
  )
  await profile.call('agent.answer', persistentAnswer)
  await waitForMessage(profile, conversationId, 'Permission allow-always')
  await waitForIdle(profile, conversationId)
  await profile.call('agent.answer', persistentAnswer)

  // A value the agent never offered is refused before anything reaches it.
  await send(profile, conversationId, 'permission three')
  const third = await waitForPendingRequest(profile, conversationId)
  await expect(
    profile.call(
      'agent.answer',
      answerIntent(third, { kind: 'choice', value: 'allow-forever' }, 'acp-permission-bogus'),
    ),
  ).rejects.toThrow()
  await profile.call('agent.answer', answerIntent(third, choiceAnswer(third, 'decline')))
  await waitForMessage(profile, conversationId, 'Permission reject-once')
  await waitForIdle(profile, conversationId)

  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).requests)
    .toEqual([])
  expect(await responses()).toEqual([
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'selected', optionId: 'allow-always' },
    { outcome: 'selected', optionId: 'reject-once' },
  ])
})

test('F024: Stop sends session/cancel, answers an open permission as cancelled, and settles on the agent-declared outcome', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents))

  await send(profile, conversationId, 'hold this turn')
  await turnRunning(profile, conversationId, agents, 'hold this turn')
  await cancelTurn(profile, conversationId)
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/cancel')).toHaveLength(1)
  const { conversation, messages: stored } = await profile.call('conversation.get', { conversation_id: conversationId })
  // The stop is confirmed by the prompt's own `cancelled` reply, not by the acknowledgement.
  expect(conversation.stop).toMatchObject({
    outcome: 'confirmed',
    confirmation: 'native_terminal',
    native_status: 'interrupted',
  })
  expect(conversation.stop?.evidence).toMatchObject({
    scope: 'turn',
    interruption_requested: true,
    termination: 'requested',
  })
  // Output the agent streamed between session/cancel and its reply belongs to the cancelled turn.
  expect(stored.find((message) => message.text === 'stopping')).toMatchObject({
    role: 'assistant',
    status: 'interrupted',
  })

  await send(profile, conversationId, 'permission then cancel')
  const pending = await waitForPendingRequest(profile, conversationId)
  await cancelTurn(profile, conversationId)
  const replies = (await acpCalls(agents)).filter((call) => call.method === undefined)
  expect(replies.map((call) => call.result)).toEqual([{ outcome: { outcome: 'cancelled' } }])
  await expect(profile.call('agent.answer', answerIntent(pending, choiceAnswer(pending, 'accept')))).rejects.toThrow()

  // The session still takes a new turn, and nothing from the cancelled turns joins it.
  await send(profile, conversationId, 'hello after cancel')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)
  expect((await messages(profile, conversationId)).filter((text) => text.startsWith('assistant:')).at(-1)).toBe(
    'assistant:Hello ACP',
  )
})

test('F024: steering, compaction and conversation rewind report the adapter limitation instead of pretending', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents))
  await send(profile, conversationId, 'hold for controls')
  await turnRunning(profile, conversationId, agents, 'hold for controls')
  const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
  const steer = await profile.call('conversation.steer', {
    operation_id: 'steer-1',
    conversation_id: conversationId,
    turn_id: conversation.active_turn_id ?? 'none',
    text: 'more',
  })
  expect(steer).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no method to steer') })
  const controls = await profile.call('conversation.controls', { conversation_id: conversationId })
  expect(Object.fromEntries(controls.controls.map((control) => [control.control, control.available]))).toMatchObject({
    steer: false,
    compact: false,
    rewind_conversation: false,
  })
  await cancelTurn(profile, conversationId)
  const compact = await profile.call('conversation.compact', {
    operation_id: 'compact-1',
    conversation_id: conversationId,
  })
  expect(compact).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no compaction method') })
  expect(
    (await methods(agents)).filter(
      (method) => !['initialize', 'session/new', 'session/prompt', 'session/cancel'].includes(method ?? ''),
    ),
  ).toEqual([])
})

test('F024: tools, plans and usage stream by native identity; late output and bursts never cross a turn boundary', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents))

  await send(profile, conversationId, 'tools please')
  await waitForMessage(profile, conversationId, 'Tools done')
  await waitForIdle(profile, conversationId)
  const { messages: stored } = await profile.call('conversation.get', { conversation_id: conversationId })
  const tool = stored.find((message) => message.provider_item_id === 'tool:tools-1')
  expect(tool).toMatchObject({ role: 'tool', status: 'completed', text: 'Read files' })
  // A native input past the frame policy stays readable as truncated JSON instead of failing the run.
  expect(tool?.content).toMatchObject({ type: 'tool', call_id: 'tools-1', output: 'two files', is_error: false })
  expect(typeof (tool?.content as { input?: unknown } | null)?.input).toBe('string')
  expect(stored.find((message) => message.kind === 'plan')?.content).toMatchObject({
    type: 'plan',
    steps: [
      { step: 'Read', status: 'completed' },
      { step: 'Answer', status: 'inProgress' },
    ],
  })

  // The agent sends "late text" after its reply: it belongs to no turn, so the next turn excludes it.
  await send(profile, conversationId, 'late reply')
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, 'hello next')
  await waitForIdle(profile, conversationId)
  // A burst of 200 chunks reaches the timeline whole and in order before the turn completes.
  await send(profile, conversationId, 'drain burst')
  await waitForIdle(profile, conversationId)
  const texts = await messages(profile, conversationId)
  expect(texts.some((text) => text.includes('late text'))).toBe(false)
  expect(texts.filter((text) => text === 'assistant:Hello ACP')).toHaveLength(2)
  expect(texts.at(-1)).toBe(`assistant:${Array.from({ length: 200 }, (_, index) => `${index} `).join('')}`)
})

test('F024: a daemon crash keeps the running ACP turn; an agent crash ends the run without resending, and load replays before its reply', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents))
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)

  // The runtime keeps the agent through a daemon crash; the recovered run still answers.
  await send(profile, conversationId, 'hold across restart')
  await turnRunning(profile, conversationId, agents, 'hold across restart')
  const agentPid = (await acpCalls(agents)).at(-1)?.pid
  await profile.restartDaemon('kill')
  await cancelTurn(profile, conversationId)
  await send(profile, conversationId, 'after restart')
  await expect.poll(async () => (await prompts(agents, 'after restart')).map((call) => call.pid)).toEqual([agentPid])
  await waitForIdle(profile, conversationId)
  const before = await messages(profile, conversationId)

  // The agent exits mid-turn: the run ends unsettled and the prompt is not sent again.
  await crashAndResume(profile, conversationId, agents)
  // The new worker loads the same native session. Its replay arrives before the load reply and
  // merges by native message ID; replayed user prompts are not imported again, and the agent's
  // "after load" output after the reply is live output belonging to no turn.
  const session = (await prompts(agents, 'hello'))[0].params?.sessionId
  await send(profile, conversationId, 'hello again')
  await expect.poll(async () => (await prompts(agents, 'hello again')).length, { timeout: 20_000 }).toBe(1)
  await waitForIdle(profile, conversationId)
  const loads = (await acpCalls(agents)).filter((call) => call.method === 'session/load')
  expect(loads.map((call) => call.params?.sessionId)).toEqual([session])
  expect((await prompts(agents, 'hello again'))[0].params?.sessionId).toBe(session)
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/new')).toHaveLength(1)
  const after = await messages(profile, conversationId)
  expect(after.filter((text) => text === 'user:hello')).toHaveLength(1)
  expect(after.filter((text) => text === 'assistant:Hello ACP')).toHaveLength(
    before.filter((text) => text === 'assistant:Hello ACP').length + 1,
  )
  expect(after.some((text) => text.includes('after load'))).toBe(false)
  expect(await prompts(agents, 'crash now')).toHaveLength(1)
})

test('F024: an agent that declares session/resume is resumed without replay, and termination never settles an open prompt', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents, 'e2e-resume', {
    ACP_FIXTURE_RESUME: '1',
    ACP_FIXTURE_CLOSE: '1',
  })
  const record = (await profile.call('adapter.list', {})).adapters.find((adapter) => adapter.provider_id === provider)
  const outcome = record?.probe?.outcome
  expect(outcome?.status === 'ready' ? outcome.worker?.native_peer?.features : null).toEqual([
    'load_session',
    'resume_session',
    'close_session',
  ])
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)
  const before = await messages(profile, conversationId)
  await crashAndResume(profile, conversationId, agents)
  await send(profile, conversationId, 'hello resumed')
  await expect.poll(async () => (await prompts(agents, 'hello resumed')).length, { timeout: 20_000 }).toBe(1)
  await waitForIdle(profile, conversationId)
  expect(await methods(agents)).toContain('session/resume')
  expect(await methods(agents)).not.toContain('session/load')
  expect((await messages(profile, conversationId)).slice(0, before.length)).toEqual(before)

  // Terminating the run while a prompt is open ends the process tree. Neither the exit nor the
  // agent's reaction to it settles that prompt, and nothing attaches it to another turn.
  await send(profile, conversationId, 'hold until terminated')
  await turnRunning(profile, conversationId, agents, 'hold until terminated')
  const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
  await profile.call('agent.terminate', {
    operation_id: 'acp-terminate',
    conversation_id: conversationId,
    source_attempt_id: conversation.runtime_run!,
  })
  await expect.poll(() => conversationStatus(profile, conversationId)).not.toMatch(/^(starting|running|waiting)$/)
  const held = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.role === 'user' && message.text === 'hold until terminated',
  )
  expect(held?.delivery?.terminal ?? null).toBeNull()
  expect(held?.delivery?.native_outcome).not.toBe('accepted')
})

test('F024: a load replay past ADE bounds, or without native message IDs, is declared as a gap instead of guessed', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents, 'e2e-replay', { ACP_FIXTURE_REPLAY_EXTRA: '40' })
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)
  await crashAndResume(profile, conversationId, agents)
  const notice = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.kind === 'notice',
  )
  expect(notice?.text).toContain('older replayed items exceed the history page')
  const extras = (await messages(profile, conversationId)).filter((text) => text.startsWith('assistant:extra '))
  expect(extras.length).toBeGreaterThan(0)
  expect(extras.length).toBeLessThan(40)

  const others = await stageAdapterAgents(ade.root)
  const anonymous = await defineAcpAdapter(profile, others, 'e2e-anonymous', { ACP_FIXTURE_ANONYMOUS: '1' })
  const second = await startConversation(profile, anonymous)
  await send(profile, second.conversationId, 'hello')
  await waitForIdle(profile, second.conversationId)
  const before = await messages(profile, second.conversationId)
  await crashAndResume(profile, second.conversationId, others)
  const after = (await profile.call('conversation.get', { conversation_id: second.conversationId })).messages
  expect(after.find((message) => message.kind === 'notice')?.text).toContain(
    'had no native message ID and were not merged',
  )
  expect(
    after.filter((message) => message.kind !== 'notice').map((message) => `${message.role}:${message.text}`),
  ).toEqual(expect.arrayContaining(before))
  expect(after.filter((message) => message.text === 'Hello ACP')).toHaveLength(1)
})

test('F024: adapter.remove is refused while a run uses the adapter, and an edited definition never resumes an old session', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents)
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)

  await expect(profile.call('adapter.remove', { id: 'e2e-acp' })).rejects.toMatchObject({ code: 'conflict' })
  expect((await profile.call('adapter.list', {})).adapters.map((adapter) => adapter.definition.id)).toEqual(['e2e-acp'])

  // An edit does not touch the running agent, which keeps the definition it launched with.
  await profile.call('adapter.put', {
    definition: {
      id: 'e2e-acp',
      name: 'E2E ACP',
      kind: 'acp',
      command: agents.acp,
      args: ['--edited'],
      env: { ACP_FIXTURE_DIR: agents.dir },
    },
  })
  await send(profile, conversationId, 'still pinned')
  await expect.poll(async () => (await prompts(agents, 'still pinned')).length).toBe(1)
  await waitForIdle(profile, conversationId)

  // Once disconnected, the session would need the edited definition: that resume is refused.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error ?? '',
    )
    .toContain('changed from revision 1 to 2')
  expect(await prompts(agents)).toHaveLength(2)
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/load')).toEqual([])

  // With no run left, the adapter can be removed; the history stays readable and cannot run.
  expect((await profile.call('adapter.remove', { id: 'e2e-acp' })).removed).toBe(true)
  expect(await messages(profile, conversationId)).toEqual(expect.arrayContaining(['user:hello', 'assistant:Hello ACP']))
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider })).rejects.toThrow(
    /No adapter has ID/,
  )
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === provider)).toBe(false)
})
