// Ticket 21, fixture tier: OpenCode as an independently packaged provider plugin
// (plugins/opencode/artifact), installed through the ordinary plugin.install and run by the
// real daemon and runtime. The native OpenCode server is the deterministic fixture
// (plugins/opencode/test/fixtures/mock-opencode.mjs); this is not installed or live evidence.
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
import { openCodeFixtureCalls, openCodeFixtureEnvironment, openCodePluginArtifact } from '../fixtures/plugins'

async function install(profile: ScratchProfile, root: string): Promise<string> {
  const installed = await profile.call('plugin.install', {
    operation_id: 'install-opencode',
    source: { kind: 'local', path: await openCodePluginArtifact(root) },
  })
  await profile.call('plugin.enable', { plugin_id: installed.plugin.id })
  return `plugin:${installed.plugin.id}`
}

async function snapshot(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId })
}

const prompts = async (root: string) => (await openCodeFixtureCalls(root)).filter((call) => call.method === 'prompt')

test('the packaged OpenCode plugin installs normally and runs a streamed turn with tools and paged history', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: openCodeFixtureEnvironment(ade.root) })
  const provider = await install(profile, ade.root)
  expect(provider).toBe('plugin:ade.opencode')
  const inspected = await profile.call('provider.inspect', { provider })
  expect(inspected).toMatchObject({
    state: 'installed_unchecked',
    descriptor: {
      name: 'OpenCode 2.0.3-fixture',
      requirements: { sdk_api_version: 2, sdk_version: '0.2.0', effect_version: '4.0.0-rc.118' },
      operations: expect.arrayContaining([
        expect.objectContaining({ method: 'send', availability: 'available' }),
        expect.objectContaining({ method: 'history', availability: 'available' }),
        expect.objectContaining({ method: 'steer', availability: 'unsupported' }),
        expect.objectContaining({ method: 'compact', availability: 'unsupported' }),
        expect.objectContaining({ method: 'rewind', availability: 'unsupported' }),
      ]),
    },
  })
  expect((await profile.call('catalog.get', {})).providers.find((entry) => entry.id === provider)).toMatchObject({
    name: 'OpenCode 2.0.3-fixture',
    capabilities: expect.arrayContaining(['streaming', 'cancel', 'tool_approval', 'questions', 'resume']),
  })

  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'tool', 'opencode-tool')
  await waitForMessage(profile, conversationId, 'Hello OpenCode')
  await waitForIdle(profile, conversationId)
  const { messages } = await snapshot(profile, conversationId)
  const users = messages.filter((message) => message.role === 'user')
  expect(users.map((message) => message.text)).toEqual(['tool'])
  expect(users[0]!.delivery).toMatchObject({
    native_outcome: 'accepted',
    native_turn_id: expect.stringMatching(/^msg_/),
  })
  const tools = messages.filter((message) => message.role === 'tool')
  expect(tools.map((message) => (message.content as { type?: string } | null | undefined)?.type)).toContain('tool')
  // The streamed reply and its stored message are one item; private reasoning is not shown.
  expect(messages.filter((message) => message.text === 'Hello OpenCode')).toHaveLength(1)
  expect(messages.some((message) => message.text.includes('Fixture reasoning'))).toBe(false)
  expect((await prompts(ade.root)).length).toBe(1)

  // Native history pages through the public query, without opening or resuming work.
  const first = await profile.call('conversation.history', { conversation_id: conversationId, max_items: 1 })
  expect(first.error).toBeNull()
  expect(first.messages.map((message) => message.text)).toEqual(['tool'])
  expect(first.complete).toBe(false)
  expect(first.snapshot).toMatchObject({ provider, consistency: 'best_effort' })
  const second = await profile.call('conversation.history', {
    conversation_id: conversationId,
    snapshot: first.snapshot,
    native_cursor: first.next_native_cursor,
    history_epoch: first.history_epoch,
    max_items: 32,
  })
  expect(second.error).toBeNull()
  expect(second.complete).toBe(true)
  expect(second.messages.map((message) => message.text)).toContain('Hello OpenCode')
  expect((await prompts(ade.root)).length).toBe(1)
})

test("an OpenCode approval is answered natively and Stop is confirmed by OpenCode's own interrupted record", async ({
  ade,
}) => {
  const profile = await ade.profile({ env: openCodeFixtureEnvironment(ade.root) })
  const provider = await install(profile, ade.root)
  const { conversationId } = await startConversation(profile, provider)

  await send(profile, conversationId, 'approval')
  const request = await waitForPendingRequest(profile, conversationId)
  expect(request.metadata).toMatchObject({ schema: { kind: 'choices' }, native_request_id: 'per_fixture' })
  await profile.call('agent.answer', answerIntent(request, choiceAnswer(request, 'accept')))
  await waitForMessage(profile, conversationId, 'Hello OpenCode')
  await waitForIdle(profile, conversationId)
  expect((await openCodeFixtureCalls(ade.root)).some((call) => String(call.path).endsWith('/reply'))).toBe(true)

  await send(profile, conversationId, 'hold')
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  const cancelled = await cancelActiveSubmission(profile, conversationId)
  // The worker reports termination confirmed only because OpenCode wrote its own
  // interrupted idle record for the turn before the cancel reply.
  expect(cancelled).toMatchObject({
    evidence: { scope: 'session', interruption_requested: true, termination: 'confirmed', queued_work_count: 0 },
  })
  await expect
    .poll(async () => (await snapshot(profile, conversationId)).conversation.stop)
    .toMatchObject({ outcome: 'confirmed', confirmation: 'native_terminal' })
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  expect((await openCodeFixtureCalls(ade.root)).some((call) => String(call.path).endsWith('/interrupt'))).toBe(true)
})

test('a missing OpenCode installation is reported by readiness and no native work starts', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_OPENCODE_BIN: '/nonexistent/opencode' } })
  const provider = await install(profile, ade.root)
  const readiness = await profile.call('provider.readiness', { provider })
  expect(readiness).toMatchObject({
    state: 'unavailable',
    reason: 'OpenCode is not installed at ADE_OPENCODE_BIN (/nonexistent/opencode)',
    checks: [
      expect.objectContaining({ check: 'worker.initialize', state: 'passed' }),
      expect.objectContaining({ check: 'provider.native_work', state: 'failed' }),
    ],
  })
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'hello').catch(() => undefined)
  await expect
    .poll(async () => (await snapshot(profile, conversationId)).conversation.error ?? '')
    .toContain('OpenCode is not installed')
})

test('a worker that dies after OpenCode accepted the prompt leaves the outcome unresolved and resume never resends it', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: openCodeFixtureEnvironment(ade.root) })
  const provider = await install(profile, ade.root)
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'kill-worker', 'accepted-then-died')
  await expect
    .poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 })
    .not.toMatch(/^(starting|ready|running|waiting)$/)
  const user = (await snapshot(profile, conversationId)).messages.find(
    (message) => message.delivery?.request_id === 'accepted-then-died',
  )
  expect(user?.delivery?.native_outcome).toBe('accepted')
  expect(user?.delivery?.terminal ?? null).toBeNull()
  expect((await prompts(ade.root)).map((call) => call.text)).toEqual(['kill-worker'])

  await profile.call('agent.resume', {
    operation_id: 'resume-' + conversationId,
    conversation_id: conversationId,
    continue_interrupted: true,
  })
  await waitForIdle(profile, conversationId)
  expect((await prompts(ade.root)).map((call) => call.text)).toEqual(['kill-worker'])
  await send(profile, conversationId, 'after recovery')
  await expect
    .poll(
      async () => (await snapshot(profile, conversationId)).messages.filter((m) => m.text === 'Hello OpenCode').length,
    )
    .toBe(1)
  expect((await prompts(ade.root)).map((call) => call.text)).toEqual(['kill-worker', 'after recovery'])
})

test('a prompt OpenCode still holds after the worker died resumes only on an explicit answer', async ({ ade }) => {
  const profile = await ade.profile({ env: openCodeFixtureEnvironment(ade.root) })
  const provider = await install(profile, ade.root)
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, 'park', 'parked-prompt')
  await expect
    .poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 })
    .not.toMatch(/^(starting|ready|running|waiting)$/)

  await profile.call('agent.resume', {
    operation_id: 'resume-' + conversationId,
    conversation_id: conversationId,
    continue_interrupted: true,
  })
  const recover = await waitForPendingRequest(profile, conversationId)
  expect(recover.metadata.summary).toContain('queued prompt')
  // Disclosure alone sends nothing: OpenCode received the prompt exactly once.
  expect((await prompts(ade.root)).map((call) => call.text)).toEqual(['park'])
  await profile.call('agent.answer', answerIntent(recover, { kind: 'choice', value: 'resume' }))
  await waitForMessage(profile, conversationId, 'Hello OpenCode')
  const calls = await prompts(ade.root)
  // The explicit resume re-delivers the same durable OpenCode prompt identity.
  expect(calls.map((call) => call.text)).toEqual(['park', 'park'])
  expect(new Set(calls.map((call) => call.id)).size).toBe(1)
})
