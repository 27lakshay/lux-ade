// F028 and D04: each adapter declares a revisioned capability record. Only
// what a record marks `supported` can be selected; native-only and unknown
// capabilities are refused, and approvals keep their once-only meaning.
import {
  answerFor,
  answerIntent,
  expect,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForPendingRequest,
} from '../fixtures'
import { conversationOn } from './steps'

const providers = ['claude', 'codex', 'omp', 'opencode']
const supportValues = ['supported', 'native_only', 'unsupported', 'unknown']

test('F028: every bundled adapter serves a sealed, revisioned record that matches what launches accept, across a daemon restart', async ({
  profile,
}) => {
  const { providers: records } = await profile.call('provider.capabilities', {})
  expect(records.map((record) => record.provider).sort()).toEqual(providers)
  const { providers: descriptors } = await profile.call('provider.list', {})
  for (const record of records) {
    expect(record.revision).toBeGreaterThanOrEqual(1)
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(record.checked_against).not.toBe('')
    for (const capability of [
      record.models.selection,
      record.models.discovery,
      record.reasoning.selection,
      record.grants.once,
      record.grants.session,
      record.grants.persistent,
      record.quota,
      record.managed_accounts,
      ...(Object.values(record.conversation) as Array<{ support: string; note: string }>),
    ]) {
      expect(supportValues).toContain(capability.support)
      expect(capability.note).not.toBe('')
    }
    // The modes a record calls supported are exactly the modes a launch accepts.
    const descriptor = descriptors.find((candidate) => candidate.id === record.provider)!
    expect(record.permission_modes.filter((mode) => mode.support === 'supported').map((mode) => mode.id)).toEqual(
      descriptor.permission_modes,
    )
    // No launch carries a reasoning level yet, so no record may claim it.
    expect(record.reasoning.selection.support).not.toBe('supported')
  }

  // One provider at a time, the same record; an unknown provider is refused.
  const {
    providers: [codex],
  } = await profile.call('provider.capabilities', { provider: 'codex' })
  expect(codex).toEqual(records.find((record) => record.provider === 'codex'))
  await expect(profile.call('provider.capabilities', { provider: 'no-such-provider' })).rejects.toThrow(
    /Unknown provider/,
  )

  // A restarted daemon seals the same records: nothing drifts without a revision.
  await profile.restartDaemon('kill')
  expect((await profile.call('provider.capabilities', {})).providers).toEqual(records)

  const cli = await profile.cli('provider', 'capabilities', 'codex')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({
    type: 'provider_capabilities',
    providers: [{ provider: 'codex', fingerprint: codex.fingerprint }],
  })
})

test('F028: a supported model and permission mode reach the provider; native-only and unknown modes are refused before launch', async ({
  profile,
}) => {
  const {
    providers: [codex],
  } = await profile.call('provider.capabilities', { provider: 'codex' })
  expect(codex.models.selection.support).toBe('supported')
  const readOnly = codex.permission_modes.find((mode) => mode.id === 'read-only')!
  expect(readOnly.support).toBe('supported')
  const fullAccess = codex.permission_modes.find((mode) => mode.id === 'danger-full-access')!
  expect(fullAccess.support).toBe('native_only')

  const { conversationId } = await conversationOn(profile, 'codex', undefined, {
    provider_config: { model: 'gpt-fixture', permission_mode: 'read-only' },
  })
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const started = (await profile.mockCalls('codex')).filter((call) => call.method === 'thread/start')
  expect(started).toHaveLength(1)
  expect(started[0].params).toMatchObject({ model: 'gpt-fixture', sandbox: 'read-only' })

  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  for (const mode of ['danger-full-access', 'no-such-mode']) {
    await expect(
      profile.call('conversation.create', {
        workspace_id: workspace.id,
        provider: 'codex',
        provider_config: { permission_mode: mode },
      }),
    ).rejects.toThrow(/Unsupported permission mode/)
  }
  // Claude's native bypass mode is not offered either.
  const {
    providers: [claude],
  } = await profile.call('provider.capabilities', { provider: 'claude' })
  for (const mode of claude.permission_modes.filter((candidate) => candidate.support !== 'supported')) {
    await expect(
      profile.call('conversation.create', {
        workspace_id: workspace.id,
        provider: 'claude',
        provider_config: { permission_mode: mode.id },
      }),
    ).rejects.toThrow(/Unsupported permission mode/)
  }
})

test('F028: an approval keeps its once-only meaning; a session-wide grant the record marks native-only is never sent', async ({
  profile,
}) => {
  const {
    providers: [codex],
  } = await profile.call('provider.capabilities', { provider: 'codex' })
  expect(codex.grants.once.support).toBe('supported')
  expect(codex.grants.session.support).toBe('native_only')
  expect(codex.grants.persistent.support).toBe('native_only')

  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  // The supported once choice is the only grant sent to Codex.
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toEqual([])
  await profile.call('agent.answer', answerIntent(approval, answerFor(approval, 'accept')))
  await waitForIdle(profile, conversationId)

  // A permission request is granted for this turn only.
  await send(profile, conversationId, 'permissions')
  const permission = await waitForPendingRequest(profile, conversationId)
  await profile.call('agent.answer', answerIntent(permission, answerFor(permission, 'accept')))
  await waitForIdle(profile, conversationId)
  const replies = (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
  expect(replies.map((reply) => reply.result)).toEqual([
    { decision: 'accept' },
    { permissions: { network: { enabled: true }, fileSystem: { write: ['/fixture-only'] } }, scope: 'turn' },
  ])
})
