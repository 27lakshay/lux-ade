// Plugin development mode (F139 backend part, F060): an edit to a local
// plugin's source reloads it as a new activation generation. Work already
// running on the old generation finishes there; new work goes to the new one.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, test, type ScratchProfile } from '../fixtures'
import { installAndEnable, pluginLines, releasePlugin, stagePlugin } from '../fixtures/plugins'

let operations = 0
const echo = 'e2e.backend.echo'

function invoke(profile: ScratchProfile, pluginId: string, commandId: string, args: unknown = null) {
  return profile.call('plugin.command.invoke', { operation_id: `dev-${process.pid}-${++operations}`, plugin_id: pluginId,
    command_id: commandId, args }, { timeoutMs: 60_000 })
}

async function echoed(profile: ScratchProfile, pluginId: string) {
  return (await invoke(profile, pluginId, echo)).outcome as { status: string; value: { version: string; generation: number; pid: number } }
}

async function generations(profile: ScratchProfile, pluginId: string) {
  return profile.call('plugin.generation.list', { plugin_id: pluginId })
}

async function current(profile: ScratchProfile, pluginId: string): Promise<number> {
  const list = await generations(profile, pluginId)
  const live = list.generations.filter((generation) => generation.state === 'current')
  expect(live).toHaveLength(1)
  return live[0].generation
}

async function setVersion(source: string, version: string): Promise<void> {
  const path = join(source, 'backend.mjs')
  const text = await readFile(path, 'utf8')
  await writeFile(path, text.replace(/^const VERSION = '.*'$/m, `const VERSION = '${version}'`))
}

test('a reload bumps the generation without cutting off the call running on the old one', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId, outDir } = await installAndEnable(profile, source)
  const entered = await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  expect(entered.dev).toMatchObject({ source_path: source, debounce_ms: 100 })
  const before = await current(profile, pluginId)
  const old = await echoed(profile, pluginId)
  expect(old.value).toMatchObject({ version: 'v1', generation: before })

  // A call holds the old generation's host while its source changes.
  const held = invoke(profile, pluginId, 'e2e.backend.hold', { release: 'release-hold' })
  await expect.poll(async () => (await pluginLines(outDir, 'lifecycle.jsonl')).some((line) => line.event === 'hold-started')).toBe(true)
  await setVersion(source, 'v2')

  await expect.poll(async () => (await generations(profile, pluginId)).generations
    .filter((generation) => generation.generation >= before)
    .map((generation) => `${generation.generation}:${generation.state}`).sort(), { timeout: 20_000 })
    .toEqual([`${before}:draining`, `${before + 1}:current`])
  // The reload records its outcome once the new generation's host has started.
  await expect.poll(async () => (await generations(profile, pluginId)).dev?.last_reload)
    .toMatchObject({ status: 'activated', generation: before + 1, message: null })
  const reloaded = await generations(profile, pluginId)
  expect(reloaded.generations.find((generation) => generation.generation === before + 1)).toMatchObject({ origin: 'dev_reload' })

  // New work reaches the new generation in a new host; the old host still runs the held call.
  const fresh = await echoed(profile, pluginId)
  expect(fresh.value).toMatchObject({ version: 'v2', generation: before + 1 })
  expect(fresh.value.pid).not.toBe(old.value.pid)
  expect(await isRunning(old.value.pid)).toBe(true)

  await releasePlugin(outDir, 'release-hold')
  expect((await held).outcome).toEqual({ status: 'completed', value: { version: 'v1', generation: before, pid: old.value.pid } })

  // Once drained, the old generation deactivates after its call finished, and retires.
  await expect.poll(() => isRunning(old.value.pid), { timeout: 20_000 }).toBe(false)
  await expect.poll(async () => (await generations(profile, pluginId)).generations
    .find((generation) => generation.generation === before)?.state ?? 'retired', { timeout: 20_000 }).toBe('retired')
  const events = (await pluginLines(outDir, 'lifecycle.jsonl')).map((line) => `${line.event}:${line.version}`)
  expect(events.indexOf('deactivate:v1')).toBeGreaterThan(events.indexOf('hold-started:v1'))
  expect(events).toContain('activate:v2')
})

test('a broken reload leaves the current generation serving; the fix activates the next, and dev mode survives a restart', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = await current(profile, pluginId)
  await echoed(profile, pluginId)

  const manifestPath = join(source, 'ade-plugin.json')
  const manifest = await readFile(manifestPath, 'utf8')
  await writeFile(manifestPath, '{ "broken": ')
  await expect.poll(async () => (await generations(profile, pluginId)).dev?.last_reload?.status, { timeout: 20_000 }).toBe('failed')
  expect((await generations(profile, pluginId)).dev?.last_reload?.message).toMatch(/manifest/i)
  expect(await current(profile, pluginId)).toBe(before)
  expect((await echoed(profile, pluginId)).value).toMatchObject({ version: 'v1', generation: before })

  await setVersion(source, 'v3')
  await writeFile(manifestPath, manifest)
  await expect.poll(() => current(profile, pluginId), { timeout: 20_000 }).toBe(before + 1)
  expect((await echoed(profile, pluginId)).value).toMatchObject({ version: 'v3', generation: before + 1 })

  // An edit made while the daemon is down is picked up when development mode resumes.
  await profile.killDaemon()
  await setVersion(source, 'v4')
  await profile.restartDaemon()
  expect((await generations(profile, pluginId)).dev).toMatchObject({ watching: true })
  await expect.poll(async () => (await echoed(profile, pluginId)).value.version, { timeout: 20_000 }).toBe('v4')

  // Leaving development mode stops reloads.
  const left = await profile.call('plugin.dev.leave', { plugin_id: pluginId })
  expect(left.dev).toBeNull()
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await expect.poll(async () => (await generations(profile, pluginId)).generations
    .filter((generation) => generation.state !== 'retired').length).toBe(0)
})

// A Conversation on a `plugin:` provider leases the current generation when it
// is created (F023, 04-S11); the adapter-launch slice closed that gap.
test('a dev-mode reload keeps a leased provider session on its old generation', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'provider')
  const { pluginId } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = await current(profile, pluginId)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await profile.call('conversation.create', { workspace_id: workspace.id, provider: `plugin:${pluginId}` })
  await writeFile(join(source, 'worker.mjs'), `${await readFile(join(source, 'worker.mjs'), 'utf8')}\n// edited\n`)
  await expect.poll(async () => (await generations(profile, pluginId)).generations
    .map((generation) => `${generation.generation}:${generation.state}`).sort(), { timeout: 20_000 })
    .toEqual([`${before}:leased`, `${before + 1}:current`])
})
