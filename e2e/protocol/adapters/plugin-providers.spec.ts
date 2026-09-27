// F023: a provider installed as a plugin runs Conversations through the same
// registry as the bundled providers. The fixture worker is
// e2e/protocol/fixtures/plugins/provider/worker.mjs.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { conversationStatus, expect, send, test, waitForIdle, waitForMessage, type ScratchProfile } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'

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

test('F023: a provider plugin runs a turn, the catalogue shows its handshake capabilities, and its history stays readable after it is disabled', async ({ ade, profile }) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const provider = `plugin:${pluginId}`
  // Capabilities come from the worker's own initialize handshake.
  expect((await profile.call('catalog.get', {})).providers.find((descriptor) => descriptor.id === provider)).toEqual({
    id: provider, name: 'E2E agent', capabilities: ['streaming', 'resume', 'cancel'], permission_modes: ['default'], setting_sources: [],
  })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, provider: 'plugin:not.installed' }))
    .rejects.toThrow(/No enabled plugin registers provider/)

  const conversationId = await create(profile, provider)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello plugin')
  await waitForIdle(profile, conversationId)

  // Uninstall is refused while a run uses the provider, even once the plugin is disabled.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect(await texts(profile, conversationId)).toEqual(['hello', 'Hello plugin'])
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === provider)).toBe(false)
  await expect(profile.call('plugin.uninstall', { operation_id: 'uninstall-busy', plugin_id: pluginId }))
    .rejects.toMatchObject({ code: 'conflict' })

  // With the run stopped, it uninstalls; the history is still readable, and the Conversation cannot run.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('plugin.uninstall', { operation_id: 'uninstall-idle', plugin_id: pluginId })
  expect(await texts(profile, conversationId)).toEqual(['hello', 'Hello plugin'])
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error ?? '')
    .toMatch(/not enabled|not installed/)
  expect(await texts(profile, conversationId)).toEqual(['hello', 'Hello plugin'])
})

test('F023/04-S11: a Conversation stays on the plugin version it started on after a newer version is enabled', async ({ ade, profile }) => {
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
  await profile.call('plugin.enable', { plugin_id: pluginId })
  // The old generation is kept because the old Conversation leases it.
  await expect.poll(() => generations(profile, pluginId)).toContain('1:leased')

  // A new Conversation starts on version 2; the old one resumes on version 1, across a daemon crash.
  const fresh = await create(profile, provider)
  await send(profile, fresh, 'new')
  await waitForMessage(profile, fresh, 'Hello from v2')
  await waitForIdle(profile, fresh)
  await profile.restartDaemon('kill')
  await profile.call('agent.resume', { conversation_id: old })
  await waitForIdle(profile, old)
  await send(profile, old, 'second')
  await expect.poll(() => texts(profile, old)).toEqual(['first', 'Hello from v1', 'second', 'Hello from v1'])
  await waitForIdle(profile, old)
})

test('04-S11: a dev-mode reload keeps a leased provider Conversation on its old generation', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'provider')
  const { pluginId } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = (await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.activation_generation
  await create(profile, `plugin:${pluginId}`)
  await writeFile(join(source, 'worker.mjs'), `${await readFile(join(source, 'worker.mjs'), 'utf8')}\n// edited\n`)
  await expect.poll(() => generations(profile, pluginId), { timeout: 20_000 })
    .toEqual([`${before}:leased`, `${before + 1}:current`])
})

test('F023: a provider worker that crashes mid-turn ends the run without redispatching the turn', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'provider')
  const worker = join(source, 'worker.mjs')
  // The worker records each send beside itself, then dies before answering it.
  await writeFile(worker, (await readFile(worker, 'utf8')).replace('  send: (params) => {',
    "  send: (params) => {\n    appendFileSync(new URL('./sends.log', import.meta.url), `${params.text}\\n`)\n    process.exit(9)")
    .replace("import { createInterface } from 'node:readline'", "import { createInterface } from 'node:readline'\nimport { appendFileSync } from 'node:fs'"))
  const { pluginId } = await installAndEnable(profile, source)
  const artifact = (await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.artifact_path
  const conversationId = await create(profile, `plugin:${pluginId}`)
  await send(profile, conversationId, 'hello')
  await expect.poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 })
    .not.toMatch(/^(starting|ready|running|waiting)$/)
  const sends = async () => (await readFile(join(artifact, 'sends.log'), 'utf8')).split('\n').filter(Boolean)
  expect(await sends()).toEqual(['hello'])
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error).toBeTruthy()
  expect(await sends()).toEqual(['hello'])
})
