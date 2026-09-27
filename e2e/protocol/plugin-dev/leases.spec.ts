// Leased provider sessions across development reloads (F060, F139 backend
// part, 04-S11). A Conversation on a `plugin:` provider leases the generation
// it started on. A reload keeps that Conversation's running worker alive and
// keeps its artifact, so it resumes on the old code even after a daemon crash;
// new Conversations reach the new generation. While a lease exists, a reload
// that would raise the data schema is refused.
import { existsSync } from 'node:fs'
import { expect, isRunning, send, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'
import { current, editFile, editManifest, generations, lastReloadAt, nextReload, states } from './dev'

async function create(profile: ScratchProfile, provider: string): Promise<string> {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  return (await profile.call('conversation.create', { workspace_id: workspace.id, provider })).conversation.id
}

/** The assistant replies, each `<version> <worker pid>`. */
async function replies(profile: ScratchProfile, conversationId: string): Promise<string[]> {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text ?? '')
}

/** Sends one turn and returns the reply it produced. */
async function turn(
  profile: ScratchProfile,
  conversationId: string,
  text: string,
): Promise<{ version: string; pid: number }> {
  const count = (await replies(profile, conversationId)).length
  await send(profile, conversationId, text)
  await expect.poll(async () => (await replies(profile, conversationId)).length, { timeout: 20_000 }).toBe(count + 1)
  await waitForIdle(profile, conversationId)
  const [version, pid] = (await replies(profile, conversationId))[count].split(' ')
  return { version, pid: Number(pid) }
}

test('a dev reload keeps a leased Conversation on its running worker and artifact, across a daemon crash; new Conversations use the new generation', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const source = await stagePlugin(ade.root, 'provider')
  // The worker answers with its code version and its process ID.
  await editFile(source, 'worker.mjs', (text) => text.replace("text: 'Hello plugin'", 'text: `v1 ${process.pid}`'))
  const { pluginId } = await installAndEnable(profile, source)
  const provider = `plugin:${pluginId}`
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  expect(await nextReload(profile, pluginId, 0)).toMatchObject({ status: 'unchanged' })
  const before = await current(profile, pluginId)
  const oldArtifact = (await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.artifact_path

  const old = await create(profile, provider)
  const first = await turn(profile, old, 'first')
  expect(first.version).toBe('v1')
  expect(await isRunning(first.pid)).toBe(true)

  await editFile(source, 'worker.mjs', (text) => text.replace('`v1 ', '`v2 '))
  await expect
    .poll(() => states(profile, pluginId), { timeout: 20_000 })
    .toEqual([`${before}:leased`, `${before + 1}:current`])
  const listed = (await generations(profile, pluginId)).generations
  expect(listed.find((generation) => generation.generation === before)).toMatchObject({ provider_leases: 1 })
  expect(listed.find((generation) => generation.generation === before + 1)).toMatchObject({
    provider_leases: 0,
    origin: 'dev_reload',
  })

  // The reload did not touch the running worker; the old Conversation keeps using it.
  expect(await isRunning(first.pid)).toBe(true)
  expect(await turn(profile, old, 'second')).toEqual(first)
  expect(existsSync(oldArtifact)).toBe(true)
  // New work goes to the new generation, in its own worker.
  const fresh = await create(profile, provider)
  const freshTurn = await turn(profile, fresh, 'new')
  expect(freshTurn.version).toBe('v2')
  expect(freshTurn.pid).not.toBe(first.pid)
  expect(await states(profile, pluginId)).toEqual([`${before}:leased`, `${before + 1}:current`])

  // A reload that raises the data schema is refused while sessions lease the plugin.
  const at = await lastReloadAt(profile, pluginId)
  await editManifest(source, (manifest) => {
    manifest.data_schema = 2
  })
  expect(await nextReload(profile, pluginId, at)).toMatchObject({
    status: 'refused',
    generation: null,
    message: expect.stringContaining(
      'raises the data schema from 1 to 2 while 2 provider session(s) lease this plugin',
    ),
  })
  expect(await current(profile, pluginId)).toBe(before + 1)

  // After a daemon crash the old Conversation still runs the old code from its kept artifact.
  await profile.restartDaemon('kill')
  expect((await generations(profile, pluginId)).dev).toMatchObject({ watching: true })
  // The restarted daemon activates a new generation; both leased ones stay.
  expect(await states(profile, pluginId)).toEqual([`${before}:leased`, `${before + 1}:leased`, `${before + 2}:current`])
  expect(
    (await generations(profile, pluginId)).generations.find((generation) => generation.generation === before + 2),
  ).toMatchObject({ origin: 'restore', provider_leases: 0 })
  expect(existsSync(oldArtifact)).toBe(true)
  await profile.call('agent.resume', { conversation_id: old })
  await waitForIdle(profile, old)
  expect((await turn(profile, old, 'third')).version).toBe('v1')
  await profile.call('agent.resume', { conversation_id: fresh })
  await waitForIdle(profile, fresh)
  expect((await turn(profile, fresh, 'again')).version).toBe('v2')
  // The refused schema change is still refused when development mode resumes.
  await expect
    .poll(async () => (await generations(profile, pluginId)).dev?.last_reload?.status, { timeout: 20_000 })
    .toBe('refused')
  expect(await current(profile, pluginId)).toBe(before + 2)
})
