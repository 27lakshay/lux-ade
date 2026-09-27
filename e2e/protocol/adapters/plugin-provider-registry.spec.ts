// F023, 04-S11: a refused plugin uninstall keeps every idle Conversation on
// the generation it started on; delegated children, parallel runs,
// provider.capabilities and provider.readiness reach plugin providers through
// the provider registry rather than the static catalogue.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, waitForMessage, type ScratchProfile } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'
import { opId, parentIn, waitForChild } from '../orchestration/steps'

async function create(profile: ScratchProfile, provider: string) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  return (await profile.call('conversation.create', { workspace_id: workspace.id, provider })).conversation.id
}

async function texts(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages.map((message) => message.text)
}

async function generations(profile: ScratchProfile, pluginId: string) {
  return (await profile.call('plugin.generation.list', { plugin_id: pluginId })).generations
    .map((generation) => `${generation.generation}:${generation.state}`).sort()
}

/** A staged copy of the provider fixture whose worker answers `reply` instead of "Hello plugin". */
async function stageReplying(root: string, reply: string, manifest: Record<string, unknown> = {}) {
  const source = await stagePlugin(root, 'provider', manifest)
  const worker = join(source, 'worker.mjs')
  await writeFile(worker, (await readFile(worker, 'utf8')).replace("text: 'Hello plugin'", `text: ${JSON.stringify(reply)}`))
  return source
}

test('04-S11: a refused uninstall releases no lease, so an idle Conversation resumes on its old version', async ({ ade, profile }) => {
  const { pluginId } = await installAndEnable(profile, await stageReplying(ade.root, 'Hello from v1'))
  const provider = `plugin:${pluginId}`
  const old = await create(profile, provider)
  await send(profile, old, 'first')
  await waitForMessage(profile, old, 'Hello from v1')
  await waitForIdle(profile, old)
  await profile.call('agent.disconnect', { conversation_id: old })

  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.install', { operation_id: 'agent-v2', source: { kind: 'local',
    path: await stageReplying(ade.root, 'Hello from v2', { version: '2.0.0' }) } })
  await expect.poll(() => generations(profile, pluginId)).toContain('1:leased')

  // Reusing another request's operation ID refuses the uninstall at admission.
  await expect(profile.call('plugin.uninstall', { operation_id: 'agent-v2', plugin_id: pluginId }))
    .rejects.toMatchObject({ code: 'conflict' })
  // The refusal released nothing: generation 1 is still leased, not retired.
  expect(await generations(profile, pluginId)).toContain('1:leased')

  await profile.call('plugin.enable', { plugin_id: pluginId })
  await profile.call('agent.resume', { conversation_id: old })
  await waitForIdle(profile, old)
  await send(profile, old, 'second')
  await expect.poll(() => texts(profile, old)).toEqual(['first', 'Hello from v1', 'second', 'Hello from v1'])
  await waitForIdle(profile, old)

  // An admitted uninstall still ends the idle lease inside its own transaction.
  await profile.call('agent.disconnect', { conversation_id: old })
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.uninstall', { operation_id: 'uninstall-idle', plugin_id: pluginId })
  await expect(profile.call('plugin.inspect', { plugin_id: pluginId })).rejects.toThrow()
  expect(await texts(profile, old)).toEqual(['first', 'Hello from v1', 'second', 'Hello from v1'])
})

test('F023: a delegated child and a parallel run can use a plugin provider', async ({ ade, profile }) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)

  // A plugin provider runs on the agent's own login; inheriting the parent's account needs its provider.
  await expect(profile.call('orchestration.delegate', { operation_id: opId('inherit'), parent_conversation_id: parent,
    caller: { kind: 'user' }, provider, account: { mode: 'inherit' }, workspace: { mode: 'same' }, task: 'hello' }))
    .rejects.toThrow(/parent's provider/)
  await expect(profile.call('orchestration.delegate', { operation_id: opId('managed'), parent_conversation_id: parent,
    caller: { kind: 'user' }, provider, account: { mode: 'managed', account_id: 'acct' }, workspace: { mode: 'same' }, task: 'hello' }))
    .rejects.toThrow(/manages no accounts/)
  await expect(profile.call('orchestration.delegate', { operation_id: opId('missing'), parent_conversation_id: parent,
    caller: { kind: 'user' }, provider: 'plugin:not.installed', account: { mode: 'ambient' }, workspace: { mode: 'same' }, task: 'hello' }))
    .rejects.toThrow(/No enabled plugin registers provider/)

  const { child } = await profile.call('orchestration.delegate', { operation_id: opId('delegate'), parent_conversation_id: parent,
    caller: { kind: 'user' }, provider, account: { mode: 'ambient' }, workspace: { mode: 'same' }, task: 'hello' })
  expect(child).toMatchObject({ provider, account_id: null })
  await waitForChild(profile, child.child_conversation_id, 'settled', { outcome: 'completed' })
  await waitForMessage(profile, child.child_conversation_id, 'Hello plugin')

  const { group } = await profile.call('orchestration.group.start', { operation_id: opId('group'), parent_conversation_id: parent,
    caller: { kind: 'user' }, task: 'hello', runs: [
      { provider, account: { mode: 'ambient' }, workspace: { mode: 'same' } },
      { provider, account: { mode: 'ambient' }, workspace: { mode: 'same' } }] })
  await expect.poll(async () => (await profile.call('orchestration.group.get', { group_id: group.group_id })).group.summary.state,
    { timeout: 20_000 }).toBe('completed')
})

test('F023: provider.capabilities and provider.readiness describe a plugin provider from its registration', async ({ ade, profile }) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  // The catalogue read runs the worker's handshake, so the record reflects what the worker declared.
  await expect.poll(async () => (await profile.call('catalog.get', {})).providers.find((d) => d.id === provider)?.capabilities)
    .toEqual(['streaming', 'resume', 'cancel'])

  const { providers } = await profile.call('provider.capabilities', { provider })
  expect(providers).toHaveLength(1)
  expect(providers[0]).toMatchObject({ provider, name: 'E2E agent',
    conversation: { resume: { support: 'supported' }, steering: { support: 'unknown' }, account_switch: { support: 'unsupported' } },
    managed_accounts: { support: 'unsupported' }, permission_modes: [{ id: 'default', support: 'supported' }] })
  expect(providers[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)
  const all = (await profile.call('provider.capabilities', {})).providers.map((record) => record.provider)
  expect(all).toEqual(expect.arrayContaining(['codex', 'claude', provider]))

  const readiness = await profile.call('provider.readiness', { provider })
  expect(readiness).toMatchObject({ provider, account_id: null, state: 'installed_unchecked', version: null,
    checks: [{ check: 'registration', state: 'passed' }] })
  expect(readiness.reason).toMatch(/cannot check/)
  await expect(profile.call('provider.readiness', { provider, account_id: 'acct' })).rejects.toThrow(/manages no accounts/)

  // A disabled plugin registers no provider; both operations say so rather than reporting stale data.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await expect(profile.call('provider.capabilities', { provider })).rejects.toThrow(/No enabled plugin registers provider/)
  await expect(profile.call('provider.readiness', { provider })).rejects.toThrow(/No enabled plugin registers provider/)
  expect((await profile.call('provider.capabilities', {})).providers.map((record) => record.provider)).not.toContain(provider)
  // Bundled providers keep their shipped records.
  expect((await profile.call('provider.capabilities', { provider: 'codex' })).providers[0].provider).toBe('codex')
})
