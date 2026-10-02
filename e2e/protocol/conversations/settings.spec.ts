// Ticket 08 / PC32: provider settings show what ADE requested beside what the provider reported
// in effect, change only at a known revision, apply the model before dependent settings, refuse
// stale or unsupported values without substituting another, and relaunch an idle Agent. Choices
// are rediscovered from what the open session listed (Codex `model/list`, Claude
// `supportedModels()`, Oh My Pi `get_available_models`); with nothing listed they are labelled
// static or unavailable.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'

const settingsOf = (profile: ScratchProfile, conversationId: string) =>
  profile.call('conversation.settings', { conversation_id: conversationId })

/** A Conversation whose Agent is connected and idle after one turn. */
async function idleConversation(profile: ScratchProfile, provider: string, reply: string) {
  const { conversationId } = await startConversation(profile, provider)
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, reply)
  await waitForIdle(profile, conversationId)
  return conversationId
}

const opens = async (profile: ScratchProfile) =>
  (await profile.mockCalls('codex')).filter((call) => call.method === 'thread/resume' || call.method === 'thread/start')

test('settings report requested and native values, and a change relaunches the idle Agent under it', async ({
  profile,
}) => {
  const conversationId = await idleConversation(profile, 'codex', turnReply.codex)

  const initial = await settingsOf(profile, conversationId)
  expect(initial).toMatchObject({
    provider: 'codex',
    revision: 0,
    agent_connected: true,
    turn_running: false,
    // Codex names the model in effect even when ADE requested none.
    model: {
      requested: null,
      effective: 'fixture-default-model',
      source: 'native_reported',
      supported: true,
      // Both model/list pages.
      choices: ['fixture-default-model', 'fixture-model-b', 'fixture-model-small'],
      choices_source: 'native_reported',
    },
    // The levels model/list lists for the model in effect.
    reasoning_effort: {
      requested: null,
      effective: null,
      source: 'provider_default',
      supported: true,
      choices: ['minimal', 'low', 'medium', 'high'],
      choices_source: 'native_reported',
    },
    // Codex lists no permission modes per model: ADE's table, labelled static.
    permission_mode: {
      requested: 'default',
      effective: null,
      source: 'requested_only',
      choices: ['default', 'read-only'],
      choices_source: 'static',
    },
    discovery: { available: true, source: 'model/list', reason: null },
  })
  // Each listed model as reported, with what ADE would offer were it selected: model B also
  // lists xhigh, which ADE cannot request for Codex, so it is not offered.
  expect(initial.discovery.models.find((model) => model.native.id === 'fixture-model-b')).toMatchObject({
    native: { display_name: 'Fixture Model B', reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
    reasoning_choices: ['low', 'medium', 'high'],
    reasoning_choices_source: 'native_reported',
    permission_choices: ['default', 'read-only'],
    permission_choices_source: 'static',
  })

  // A stale revision, an unlisted model and an unoffered value are refused, and nothing changes.
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-stale',
      conversation_id: conversationId,
      expected_revision: 7,
      model: 'fixture-model-b',
    }),
  ).rejects.toThrow(/read them again/)
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-unlisted',
      conversation_id: conversationId,
      expected_revision: 0,
      model: 'fixture-model-unlisted',
    }),
  ).rejects.toThrow(/codex does not list model fixture-model-unlisted/)
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-unoffered',
      conversation_id: conversationId,
      expected_revision: 0,
      model: 'fixture-model-b',
      reasoning_effort: 'extreme',
    }),
  ).rejects.toThrow(/fixture-model-b does not offer reasoning level extreme/)
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-mode',
      conversation_id: conversationId,
      expected_revision: 0,
      permission_mode: 'bypass',
    }),
  ).rejects.toThrow(/does not offer permission mode bypass/)
  expect(await settingsOf(profile, conversationId)).toEqual(initial)

  // A valid change is stored, applied by relaunching, and reported by the provider.
  const update = {
    operation_id: 'settings-model',
    conversation_id: conversationId,
    expected_revision: 0,
    model: 'fixture-model-b',
    reasoning_effort: 'high',
  }
  const updated = await profile.call('conversation.settings.update', update)
  expect(updated).toMatchObject({
    changed: ['model', 'reasoning_effort'],
    relaunched: true,
    native_error: null,
    settings: {
      revision: 1,
      // The relaunch has started; the provider's report arrives with the new session.
      model: { requested: 'fixture-model-b', effective: null, source: 'requested_only' },
      reasoning_effort: { requested: 'high' },
    },
  })
  await expect
    .poll(async () => (await settingsOf(profile, conversationId)).model)
    .toMatchObject({ effective: 'fixture-model-b', source: 'native_reported' })
  // The new session lists its models again; model B also lists xhigh, which ADE cannot
  // request for Codex, so it is not offered.
  expect((await settingsOf(profile, conversationId)).reasoning_effort).toMatchObject({
    choices: ['low', 'medium', 'high'],
    choices_source: 'native_reported',
  })
  await waitForIdle(profile, conversationId)
  // A retried operation returns its first reply without a second relaunch.
  expect(await profile.call('conversation.settings.update', update)).toEqual(updated)
  expect((await opens(profile)).at(-1)?.params).toMatchObject({ model: 'fixture-model-b' })

  // The requested reasoning level reaches the next native turn.
  await send(profile, conversationId, prompts.turn, 'after-settings')
  await waitForIdle(profile, conversationId)
  const turns = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect(turns.at(-1)?.params).toMatchObject({ effort: 'high' })

  // The CLI reads the same values and changes them through the same rules.
  const cli = await profile.cli('conversation', 'settings', conversationId)
  expect(cli.json).toMatchObject({ revision: 1, model: { effective: 'fixture-model-b' } })
  const reset = await profile.cli('conversation', 'configure', conversationId, '--revision', '1', '--reasoning', '-')
  expect(reset.code, reset.stderr).toBe(0)
  expect(reset.json).toMatchObject({
    changed: ['reasoning_effort'],
    settings: { revision: 2, reasoning_effort: { requested: null } },
  })
})

test('PC32: a dependent setting the new model does not offer refuses the whole change, and nothing is applied', async ({
  profile,
}) => {
  const conversationId = await idleConversation(profile, 'codex', turnReply.codex)
  await profile.call('conversation.settings.update', {
    operation_id: 'settings-first',
    conversation_id: conversationId,
    expected_revision: 0,
    model: 'fixture-model-b',
    reasoning_effort: 'high',
  })
  await expect.poll(async () => (await settingsOf(profile, conversationId)).model.effective).toBe('fixture-model-b')
  await waitForIdle(profile, conversationId)
  const before = {
    settings: await settingsOf(profile, conversationId),
    conversation: (await profile.call('conversation.get', { conversation_id: conversationId })).conversation,
    opens: (await opens(profile)).length,
  }

  // The second update changes the model; the reasoning level it keeps is one the new model
  // does not list. The model is applied first, then the dependent check refuses the change.
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-dependent-kept',
      conversation_id: conversationId,
      expected_revision: 1,
      model: 'fixture-model-small',
    }),
  ).rejects.toThrow(/fixture-model-small does not offer reasoning level high, which stays requested/)
  // The same when the unoffered level is requested with the model.
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-dependent-new',
      conversation_id: conversationId,
      expected_revision: 1,
      model: 'fixture-model-small',
      reasoning_effort: 'high',
    }),
  ).rejects.toThrow(/fixture-model-small does not offer reasoning level high/)

  // Observable state is unchanged: settings, the Conversation, and no relaunch.
  expect(await settingsOf(profile, conversationId)).toEqual(before.settings)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation).toEqual(
    before.conversation,
  )
  expect((await opens(profile)).length).toBe(before.opens)

  // A level the new model offers applies, and its choices are the new model's.
  const applied = await profile.call('conversation.settings.update', {
    operation_id: 'settings-dependent-valid',
    conversation_id: conversationId,
    expected_revision: 1,
    model: 'fixture-model-small',
    reasoning_effort: 'low',
  })
  expect(applied).toMatchObject({ changed: ['model', 'reasoning_effort'], relaunched: true, settings: { revision: 2 } })
  await expect
    .poll(async () => (await settingsOf(profile, conversationId)).reasoning_effort)
    .toMatchObject({ requested: 'low', choices: ['low', 'medium'], choices_source: 'native_reported' })
})

test('without discovery the choices say so: static levels, no model list, and the reason', async ({ profile }) => {
  await profile.releaseMock('codex', 'refuse-model-list')
  const conversationId = await idleConversation(profile, 'codex', turnReply.codex)
  const settings = await settingsOf(profile, conversationId)
  expect(settings).toMatchObject({
    model: { effective: 'fixture-default-model', choices: [], choices_source: 'unavailable' },
    reasoning_effort: { choices: ['minimal', 'low', 'medium', 'high'], choices_source: 'static' },
    discovery: { available: false, source: null, reason: 'codex listed no models for this session', models: [] },
  })
  // A model is then free text, validated by the provider when it launches.
  expect(
    await profile.call('conversation.settings.update', {
      operation_id: 'settings-free-text',
      conversation_id: conversationId,
      expected_revision: 0,
      model: 'fixture-model-unlisted',
    }),
  ).toMatchObject({ changed: ['model'] })

  // With no Agent connected, discovery is unavailable and says why.
  const { conversationId: offline } = await startConversation(profile, 'codex')
  expect((await settingsOf(profile, offline)).discovery).toMatchObject({
    available: false,
    reason: 'No Agent is connected; choices are discovered when one opens',
  })
})

test('Claude: supportedModels lists per-model effort levels, the effort reaches the SDK, and init reports what is in effect', async ({
  profile,
}) => {
  const conversationId = await idleConversation(profile, 'claude', turnReply.claude)
  const initial = await settingsOf(profile, conversationId)
  expect(initial).toMatchObject({
    // system/init names the resolved model and the permission mode, but not effort.
    model: {
      requested: null,
      effective: 'fixture-sonnet',
      source: 'native_reported',
      choices: ['default', 'fixture-opus', 'fixture-haiku'],
      choices_source: 'native_reported',
    },
    reasoning_effort: {
      effective: null,
      source: 'provider_default',
      choices: ['low', 'medium', 'high', 'xhigh'],
      choices_source: 'native_reported',
    },
    permission_mode: { effective: 'default', source: 'native_reported', choices_source: 'static' },
    discovery: { available: true, source: 'supportedModels' },
  })
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'claude-max',
      conversation_id: conversationId,
      expected_revision: 0,
      reasoning_effort: 'max',
    }),
  ).rejects.toThrow(/fixture-sonnet does not offer reasoning level max/)
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'claude-haiku',
      conversation_id: conversationId,
      expected_revision: 0,
      model: 'fixture-haiku',
      reasoning_effort: 'low',
    }),
  ).rejects.toThrow(/fixture-haiku does not offer reasoning level low/)
  expect(
    await profile.call('conversation.settings.update', {
      operation_id: 'claude-opus',
      conversation_id: conversationId,
      expected_revision: 0,
      model: 'fixture-opus',
      reasoning_effort: 'max',
      permission_mode: 'plan',
    }),
  ).toMatchObject({ relaunched: true, native_error: null })
  await expect
    .poll(async () => {
      const settings = await settingsOf(profile, conversationId)
      return [settings.model.effective, settings.permission_mode.effective, settings.reasoning_effort.source]
    })
    .toEqual(['fixture-opus', 'plan', 'requested_only'])
  const launches = (await profile.mockCalls('claude')).filter((call) => call.method === 'launch')
  expect(launches.at(-1)).toMatchObject({ model: 'fixture-opus', effort: 'max' })
})

test('Oh My Pi: get_state reports the model and thinking level, and get_available_models lists the models', async ({
  ade,
}) => {
  const calls = join(ade.root, 'omp-mock')
  await mkdir(calls, { recursive: true })
  const profile = await ade.profile({
    env: { ADE_OMP_BIN: join(repositoryRoot, 'providers/omp/mock-cli.mjs'), ADE_MOCK_OMP_DIR: calls },
  })
  const conversationId = await idleConversation(profile, 'omp', 'Hello Oh My Pi')
  expect(await settingsOf(profile, conversationId)).toMatchObject({
    model: {
      effective: 'fixture/omp-default',
      source: 'native_reported',
      choices: ['fixture/omp-default', 'fixture/omp-plain'],
      choices_source: 'native_reported',
    },
    // OMP reports its thinking level; ADE cannot select one for it yet.
    reasoning_effort: { effective: 'medium', source: 'native_reported', supported: false },
    permission_mode: { effective: null, source: 'requested_only', choices: ['default'] },
    discovery: { available: true, source: 'get_available_models' },
  })
})

test('settings refuse a change while a turn runs and never relaunch it', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  expect((await settingsOf(profile, conversationId)).turn_running).toBe(true)
  await expect(
    profile.call('conversation.settings.update', {
      operation_id: 'settings-busy',
      conversation_id: conversationId,
      expected_revision: 0,
      model: 'fixture-model-b',
    }),
  ).rejects.toThrow(/A turn is running/)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status).toBe(
    'running',
  )
})
