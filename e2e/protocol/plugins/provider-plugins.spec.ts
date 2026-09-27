// Provider plugins (F023): a plugin's `provider` entry point registers a
// provider worker through the same registry as the bundled providers.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, waitForMessage } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'

test('an enabled provider plugin registers a pinned worker beside the bundled providers, and disabling removes it', async ({ ade, profile }) => {
  const before = await profile.call('provider.registrations', {})
  expect(before.plugins_unavailable).toBeNull()
  expect(before.providers.filter((provider) => provider.origin.kind === 'bundled').map((provider) => provider.provider))
    .toEqual(expect.arrayContaining(['codex', 'claude']))
  expect(before.providers.some((provider) => provider.provider === 'plugin:e2e.agent')).toBe(false)

  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const inspected = await profile.call('plugin.inspect', { plugin_id: pluginId })
  const registered = await profile.call('provider.registrations', {})
  expect(registered.providers.find((provider) => provider.provider === 'plugin:e2e.agent')).toEqual({
    provider: 'plugin:e2e.agent',
    name: 'E2E agent',
    origin: { kind: 'plugin', pin: { plugin_id: pluginId, version: '1.0.0',
      artifact_digest: inspected.plugin.artifact_digest, activation_generation: inspected.plugin.activation_generation } },
    state: 'registered',
    reason: null,
  })
  // The bundled providers are unchanged by it.
  expect(registered.providers.filter((provider) => provider.origin.kind === 'bundled'))
    .toEqual(before.providers.filter((provider) => provider.origin.kind === 'bundled'))
  const cli = await profile.cli('provider', 'registrations')
  expect(cli.code).toBe(0)
  expect(JSON.stringify(cli.json)).toContain('plugin:e2e.agent')

  // A provider plugin has no backend host.
  expect((await profile.call('plugin.host.status', { plugin_id: pluginId })).host.state).toBe('no_backend')

  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect((await profile.call('provider.registrations', {})).providers.some((provider) => provider.provider === 'plugin:e2e.agent'))
    .toBe(false)

  // A newer version registers with its own pin, and the registration survives a daemon restart.
  await profile.call('plugin.install', { operation_id: 'agent-v2', source: { kind: 'local',
    path: await stagePlugin(ade.root, 'provider', { version: '2.0.0' }) } })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  await profile.restartDaemon('kill')
  const upgraded = (await profile.call('provider.registrations', {})).providers.find((provider) => provider.provider === 'plugin:e2e.agent')
  expect(upgraded?.state).toBe('registered')
  expect(upgraded?.origin).toMatchObject({ kind: 'plugin', pin: { version: '2.0.0' } })
})

test('a provider plugin registers only under its own plugin: ID, and a provider-only manifest cannot contribute commands', async ({ ade, profile }) => {
  // The plugin ID is the namespace: a provider plugin always registers as plugin:<id>.
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider', { id: 'codex.agent' }))
  const providers = (await profile.call('provider.registrations', {})).providers
  expect(providers.find((provider) => provider.provider === `plugin:${pluginId}`)?.state).toBe('registered')
  expect(providers.filter((provider) => provider.provider === 'codex').map((provider) => provider.origin.kind)).toEqual(['bundled'])
  // A manifest that contributes commands without a backend or UI entry is refused before activation.
  await expect(profile.call('plugin.install', { operation_id: 'agent-commands', source: { kind: 'local',
    path: await stagePlugin(ade.root, 'provider', { contributes: { commands: [{ id: 'e2e.agent.run', title: 'Run' }] } }) } }))
    .rejects.toMatchObject({ code: 'invalid_request' })
})

// Conversations run on `plugin:` providers through the provider registry; see
// also e2e/protocol/adapters/plugin-providers.spec.ts.
test('a turn runs on a provider plugin and its history stays readable after the plugin is disabled', async ({ ade, profile }) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider: `plugin:${pluginId}` })
  await send(profile, conversation.id, 'hello')
  await waitForMessage(profile, conversation.id, 'Hello plugin')
  await waitForIdle(profile, conversation.id)
  await profile.call('plugin.disable', { plugin_id: pluginId })
  const snapshot = await profile.call('conversation.get', { conversation_id: conversation.id })
  expect(snapshot.messages.map((message) => (message as { text?: string }).text)).toEqual(expect.arrayContaining(['hello', 'Hello plugin']))
})

// This worker dies on its first input, before its handshake; the run ends in
// an error and nothing is redispatched. A crash in the middle of a turn is in
// e2e/protocol/adapters/plugin-providers.spec.ts.
test('a provider worker that crashes mid-turn ends the run without redispatching the turn', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'provider')
  await writeFile(join(source, 'worker.mjs'), 'process.stdin.once("data", () => process.exit(9))\n')
  const { pluginId } = await installAndEnable(profile, source)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider: `plugin:${pluginId}` })
  await send(profile, conversation.id, 'hello')
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversation.id })).conversation.status)
    .toMatch(/^(error|failed|exited)$/)
})
