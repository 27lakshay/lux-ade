// F024: a conforming ACP peer runs Conversations through a generic adapter.
// The fixture agent is e2e/protocol/fixtures/adapters/acp_agent.mjs; it
// records every message it receives, so each spec can prove what reached the
// agent and how often.
import { conversationStatus, expect, send, startConversation, test, waitForIdle, waitForMessage,
  waitForPendingRequest, type ScratchProfile } from '../fixtures'
import { acpCalls, defineAcpAdapter, stageAdapterAgents, type AdapterAgents } from '../fixtures/adapters'

async function prompts(agents: AdapterAgents, text?: string) {
  return (await acpCalls(agents)).filter((call) => call.method === 'session/prompt'
    && (text === undefined || JSON.stringify(call.params?.prompt).includes(text)))
}

/** Cancel the running turn: it settles as interrupted and pauses the queue, which is resumed for the next send. */
async function cancelTurn(profile: ScratchProfile, conversationId: string) {
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
}

async function turnRunning(profile: ScratchProfile, conversationId: string) {
  await expect.poll(async () => {
    const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
    return conversation.status === 'running' && conversation.active_turn_id !== null
  }).toBe(true)
}

async function messages(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages
    .map((message) => `${message.role}:${message.text}`)
}

test('F024: an ACP adapter runs a turn, and only a ready adapter is listed and accepted', async ({ ade, profile }) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents)
  expect(provider).toBe('adapter:e2e-acp')

  // The catalogue lists the adapter with the capabilities its initialize declared, and nothing more.
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.providers.find((descriptor) => descriptor.id === provider)).toEqual({
    id: provider, name: 'E2E ACP', capabilities: ['streaming', 'cancel', 'tool_approval', 'resume'],
    permission_modes: ['default'], setting_sources: [],
  })
  expect(catalog.providers.map((descriptor) => descriptor.id)).toEqual(expect.arrayContaining(['codex', 'claude']))

  // An unprobed adapter is neither listed nor accepted; a probe makes it both.
  await profile.call('adapter.put', { definition: { id: 'e2e-unprobed', name: 'Unprobed', kind: 'acp',
    command: agents.acp, env: { ACP_FIXTURE_DIR: agents.dir } } })
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === 'adapter:e2e-unprobed')).toBe(false)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider: 'adapter:e2e-unprobed' }))
    .rejects.toThrow(/not ready; probe it/)
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider: 'adapter:missing' }))
    .rejects.toThrow(/No adapter has ID missing/)
  // An adapter declares only the default permission mode; another is refused before anything runs.
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider,
    provider_config: { permission_mode: 'plan' } })).rejects.toThrow(/Unsupported permission mode/)
  // Adapters use the agent's own login.
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider, account_id: 'account_x' }))
    .rejects.toThrow(/manages no accounts/)

  const { conversationId } = await startConversation(profile, provider as never)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)
  expect(await messages(profile, conversationId)).toEqual(['user:hello', 'assistant:Hello ACP'])
  expect(await prompts(agents)).toHaveLength(1)
  const methods = (await acpCalls(agents)).map((call) => call.method)
  expect(methods).toEqual(expect.arrayContaining(['initialize', 'session/new', 'session/prompt']))

  // A second turn on the same native session.
  await send(profile, conversationId, 'again')
  await expect.poll(async () => (await messages(profile, conversationId)).length).toBe(4)
  await waitForIdle(profile, conversationId)
  const sessions = new Set((await prompts(agents)).map((call) => call.params?.sessionId))
  expect(sessions.size).toBe(1)

  // A different protocol version is refused at probe time, so it never reaches a Conversation.
  await profile.call('adapter.put', { definition: { id: 'e2e-v2', name: 'V2', kind: 'acp', command: agents.acp,
    env: { ACP_FIXTURE_DIR: agents.dir, ACP_FIXTURE_PROTOCOL: '2' } } })
  const refused = await profile.call('adapter.probe', { id: 'e2e-v2' })
  expect(refused.adapter.readiness).toBe('failed')
  expect(JSON.stringify(refused.adapter.probe)).toContain('ADE supports version 1 only')
})

test('F024/F028: permission answers keep once-only and persistent meanings, and a repeat answer converges', async ({ ade, profile }) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents) as never)
  const responses = async () => (await acpCalls(agents)).filter((call) => call.method === undefined)
    .map((call) => (call.result as { outcome?: { outcome: string; optionId?: string } } | undefined)?.outcome)

  // accept selects the agent's allow_once option.
  await send(profile, conversationId, 'permission one')
  const first = await waitForPendingRequest(profile, conversationId)
  expect(await conversationStatus(profile, conversationId)).toBe('waiting')
  expect((first.params.options as Array<{ kind: string }>).map((option) => option.kind))
    .toEqual(['allow_once', 'allow_always', 'reject_once'])
  const answer = { conversation_id: conversationId, request_id: first.id, decision: 'accept' }
  await profile.call('agent.answer', answer)
  await waitForMessage(profile, conversationId, 'Permission allow-once')
  await waitForIdle(profile, conversationId)
  // The same answer again converges without a second reply to the agent.
  await profile.call('agent.answer', answer)
  await expect(profile.call('agent.answer', { ...answer, decision: 'decline' })).rejects.toThrow()
  expect(await responses()).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])

  // A persistent grant is chosen only when named, and a named option must match the decision.
  await send(profile, conversationId, 'permission two')
  const second = await waitForPendingRequest(profile, conversationId)
  await expect(profile.call('agent.answer', { conversation_id: conversationId, request_id: second.id,
    decision: 'decline', answers: { option_id: 'allow-always' } })).rejects.toThrow(/does not match the decision/)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).requests.map((r) => r.status))
    .toEqual(['pending'])
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: second.id,
    decision: 'accept', answers: { option_id: 'allow-always' } })
  await waitForMessage(profile, conversationId, 'Permission allow-always')
  await waitForIdle(profile, conversationId)

  // decline selects reject_once.
  await send(profile, conversationId, 'permission three')
  const third = await waitForPendingRequest(profile, conversationId)
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: third.id, decision: 'decline' })
  await waitForMessage(profile, conversationId, 'Permission reject-once')
  await waitForIdle(profile, conversationId)
  expect(await responses()).toEqual([
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'selected', optionId: 'allow-always' },
    { outcome: 'selected', optionId: 'reject-once' },
  ])
})

test('F024: cancel ends a running turn and answers an open permission request as cancelled', async ({ ade, profile }) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents) as never)

  await send(profile, conversationId, 'hold this turn')
  await turnRunning(profile, conversationId)
  await cancelTurn(profile, conversationId)
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/cancel')).toHaveLength(1)

  await send(profile, conversationId, 'permission then cancel')
  const pending = await waitForPendingRequest(profile, conversationId)
  await cancelTurn(profile, conversationId)
  // The protocol requires the open request to be answered with the cancelled outcome.
  const replies = (await acpCalls(agents)).filter((call) => call.method === undefined)
  expect(replies.map((call) => call.result)).toEqual([{ outcome: { outcome: 'cancelled' } }])
  await expect(profile.call('agent.answer', { conversation_id: conversationId, request_id: pending.id, decision: 'accept' }))
    .rejects.toThrow()
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).requests
    .filter((request) => request.status === 'pending')).toEqual([])

  // The session still takes a new turn.
  await send(profile, conversationId, 'hello after cancel')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)
})

test('F024: steering, compaction and conversation rewind report the adapter limitation instead of pretending', async ({ ade, profile }) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents) as never)
  await send(profile, conversationId, 'hold for controls')
  await turnRunning(profile, conversationId)
  const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
  const steer = await profile.call('conversation.steer', { operation_id: 'steer-1', conversation_id: conversationId,
    turn_id: conversation.active_turn_id ?? '', text: 'more' })
  expect(steer).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no native steer path') })
  const controls = await profile.call('conversation.controls', { conversation_id: conversationId })
  expect(Object.fromEntries(controls.controls.map((control) => [control.control, control.available]))).toMatchObject({
    steer: false, compact: false, rewind_conversation: false,
  })
  await cancelTurn(profile, conversationId)
  const compact = await profile.call('conversation.compact', { operation_id: 'compact-1', conversation_id: conversationId })
  expect(compact).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no compaction method') })
  // Nothing reached the agent for either control.
  expect((await acpCalls(agents)).map((call) => call.method).filter((method) => method && !['initialize',
    'session/new', 'session/prompt', 'session/cancel'].includes(method))).toEqual([])
})

test('F024: a daemon crash keeps the running ACP turn; an agent crash ends the run without resending, and resume loads the native session', async ({ ade, profile }) => {
  const agents = await stageAdapterAgents(ade.root)
  const { conversationId } = await startConversation(profile, await defineAcpAdapter(profile, agents) as never)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)

  // The runtime keeps the agent through a daemon crash; the recovered run still answers.
  await send(profile, conversationId, 'hold across restart')
  await turnRunning(profile, conversationId)
  const agentPid = (await acpCalls(agents)).at(-1)?.pid
  await profile.restartDaemon('kill')
  await cancelTurn(profile, conversationId)
  await send(profile, conversationId, 'after restart')
  await expect.poll(async () => (await prompts(agents, 'after restart')).map((call) => call.pid)).toEqual([agentPid])
  await waitForIdle(profile, conversationId)

  // The agent crashes mid-turn: the run ends and the prompt is not sent again.
  await send(profile, conversationId, 'crash now')
  await expect.poll(() => conversationStatus(profile, conversationId)).not.toMatch(/^(starting|running|waiting)$/)
  expect(await prompts(agents, 'crash now')).toHaveLength(1)

  // The next send starts a new agent, which loads the native session instead of opening another.
  const session = (await prompts(agents, 'hello'))[0].params?.sessionId
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await send(profile, conversationId, 'hello again')
  await expect.poll(async () => (await prompts(agents, 'hello again')).length, { timeout: 20_000 }).toBe(1)
  await waitForIdle(profile, conversationId)
  const loads = (await acpCalls(agents)).filter((call) => call.method === 'session/load')
  expect(loads.map((call) => call.params?.sessionId)).toEqual([session])
  expect((await prompts(agents, 'hello again'))[0].params?.sessionId).toBe(session)
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/new')).toHaveLength(1)
  expect(await prompts(agents, 'crash now')).toHaveLength(1)
})

test('F024: adapter.remove is refused while a run uses the adapter, and an edited definition never resumes an old session', async ({ ade, profile }) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents)
  const { conversationId } = await startConversation(profile, provider as never)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello ACP')
  await waitForIdle(profile, conversationId)

  await expect(profile.call('adapter.remove', { id: 'e2e-acp' })).rejects.toMatchObject({ code: 'conflict' })
  expect((await profile.call('adapter.list', {})).adapters.map((adapter) => adapter.definition.id)).toEqual(['e2e-acp'])

  // An edit does not touch the running agent, which keeps the definition it launched with.
  await profile.call('adapter.put', { definition: { id: 'e2e-acp', name: 'E2E ACP', kind: 'acp', command: agents.acp,
    args: ['--edited'], env: { ACP_FIXTURE_DIR: agents.dir } } })
  await send(profile, conversationId, 'still pinned')
  await expect.poll(async () => (await prompts(agents, 'still pinned')).length).toBe(1)
  await waitForIdle(profile, conversationId)

  // Once disconnected, the session would need the edited definition: that resume is refused.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error ?? '')
    .toContain('changed from revision 1 to 2')
  expect(await prompts(agents)).toHaveLength(2)
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/load')).toEqual([])

  // With no run left, the adapter can be removed; the history stays readable and cannot run.
  expect((await profile.call('adapter.remove', { id: 'e2e-acp' })).removed).toBe(true)
  expect(await messages(profile, conversationId)).toEqual(expect.arrayContaining(['user:hello', 'assistant:Hello ACP']))
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider })).rejects.toThrow(/No adapter has ID/)
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === provider)).toBe(false)
})
