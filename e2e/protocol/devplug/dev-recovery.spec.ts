// Plugin development recovery (F060, F139 backend part). A development-mode
// edit whose new code fails to activate is reported on the reload itself and
// in the host status; the broken generation is never retried beyond its
// restart schedule, and the next edit that fixes it activates and serves.
// Leased provider sessions across a reload are proven in
// `adapters/plugin-providers.spec.ts`; the reload of a working edit and a
// broken manifest in `plugins/dev-reload.spec.ts`.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'

let operations = 0

function echo(profile: ScratchProfile, pluginId: string) {
  return profile.call('plugin.command.invoke', { operation_id: `dev-recovery-${process.pid}-${++operations}`,
    plugin_id: pluginId, command_id: 'e2e.backend.echo', args: null }, { timeoutMs: 60_000 })
}

async function edit(source: string, change: (text: string) => string): Promise<void> {
  const path = join(source, 'backend.mjs')
  await writeFile(path, change(await readFile(path, 'utf8')))
}

test('a dev reload whose code throws in activate is reported and contained; the next edit that fixes it serves', async ({ ade, profile }) => {
  test.setTimeout(90_000)
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId, outDir } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const first = (await echo(profile, pluginId)).generation
  const original = await readFile(join(source, 'backend.mjs'), 'utf8')

  await edit(source, (text) => text.replace('  context = ctx\n', "  context = ctx\n  throw new Error('dev edit broke activate')\n"))
  // The reload activates a new generation, and its outcome names the start failure.
  await expect.poll(async () => (await profile.call('plugin.generation.list', { plugin_id: pluginId })).dev?.last_reload,
    { timeout: 20_000 }).toMatchObject({ status: 'activated', generation: first + 1,
    message: expect.stringContaining('dev edit broke activate') })
  await expect(echo(profile, pluginId)).rejects.toThrow(/dev edit broke activate|crashed/)
  // Its host is supervised like any other: bounded restarts, then errored.
  await expect.poll(async () => (await profile.call('plugin.host.status', { plugin_id: pluginId })).host.state,
    { timeout: 30_000 }).toBe('errored')
  const status = (await profile.call('plugin.host.status', { plugin_id: pluginId })).host
  expect(status).toMatchObject({ generation: first + 1, last_error: expect.stringContaining('dev edit broke activate') })
  // The core stays available while the plugin is broken.
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  expect(workspace.id).toBeTruthy()

  // The fix is the next edit: a new generation activates, with a fresh restart schedule.
  await writeFile(join(source, 'backend.mjs'), original.replace("const VERSION = 'v1'", "const VERSION = 'v2'"))
  await expect.poll(async () => (await profile.call('plugin.generation.list', { plugin_id: pluginId })).dev?.last_reload,
    { timeout: 20_000 }).toMatchObject({ status: 'activated', generation: first + 2, message: null })
  const fixed = await echo(profile, pluginId)
  expect(fixed).toMatchObject({ generation: first + 2, outcome: { status: 'completed', value: { version: 'v2' } } })
  expect((await profile.call('plugin.host.status', { plugin_id: pluginId })).host).toMatchObject({ state: 'running', crashes: 0 })
  expect((await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === 'activate').map((line) => line.version))
    .toEqual(['v1', 'v2'])
})
