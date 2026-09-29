// Reload rules (F060, F139 backend part). A development-mode reload never
// tears down the running generation before a new one commits. A copy equal to
// the installed artifact changes nothing; a source that now names another
// plugin, or lowers the data schema below what is stored, is refused and the
// current generation keeps serving. Development mode accepts only an enabled
// plugin from a local directory and a bounded debounce, and a source that
// never goes quiet still reloads at the 10 s cap.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'
import { current, echoed, editManifest, generations, lastReloadAt, nextReload, setVersion, states } from './dev'

const execFileAsync = promisify(execFile)

test('an unchanged copy changes nothing; a renamed plugin or a lowered data schema is refused and the current generation keeps serving', async ({
  ade,
  profile,
}) => {
  test.setTimeout(90_000)
  const source = await stagePlugin(ade.root, 'backend', { data_schema: 2 })
  const { pluginId } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = await current(profile, pluginId)
  const serving = await echoed(profile, pluginId)
  const servesUnchanged = async () => {
    expect(await states(profile, pluginId)).toEqual([`${before}:current`])
    expect(await echoed(profile, pluginId)).toEqual(serving)
  }

  // Entering counts the first scan as a change; the copy matches the artifact.
  expect(await nextReload(profile, pluginId, 0)).toMatchObject({ status: 'unchanged', generation: null, message: null })
  await servesUnchanged()
  // A touched file with the same content is the same artifact.
  let at = await lastReloadAt(profile, pluginId)
  const later = new Date(Date.now() + 5_000)
  await utimes(join(source, 'backend.mjs'), later, later)
  expect(await nextReload(profile, pluginId, at)).toMatchObject({ status: 'unchanged', generation: null })
  await servesUnchanged()

  // A source that declares another plugin ID is refused; it must be installed separately.
  const manifest = await readFile(join(source, 'ade-plugin.json'), 'utf8')
  at = await lastReloadAt(profile, pluginId)
  await editManifest(source, (next) => {
    next.id = 'e2e.renamed'
    const contributes = next.contributes as { commands: Array<{ id: string }> }
    for (const command of contributes.commands) command.id = command.id.replace('e2e.backend.', 'e2e.renamed.')
  })
  expect(await nextReload(profile, pluginId, at)).toMatchObject({
    status: 'refused',
    generation: null,
    message: expect.stringContaining('now declares plugin e2e.renamed'),
  })
  await servesUnchanged()

  // Code rollback does not roll data back: a lower data schema is refused.
  at = await lastReloadAt(profile, pluginId)
  await editManifest(source, (next) => {
    Object.assign(next, JSON.parse(manifest), { data_schema: 1 })
  })
  expect(await nextReload(profile, pluginId, at)).toMatchObject({
    status: 'refused',
    message: expect.stringContaining('Plugin data is at schema 2; the source declares 1'),
  })
  await servesUnchanged()

  // With no provider session leasing it, a higher data schema is accepted and recorded.
  at = await lastReloadAt(profile, pluginId)
  await setVersion(source, 'v3')
  await editManifest(source, (next) => {
    next.data_schema = 3
  })
  await expect
    .poll(async () => (await generations(profile, pluginId)).dev?.last_reload, { timeout: 20_000 })
    .toMatchObject({ status: 'activated', generation: before + 1 })
  expect(await lastReloadAt(profile, pluginId)).toBeGreaterThan(at)
  expect(await echoed(profile, pluginId)).toMatchObject({ value: { version: 'v3', generation: before + 1 } })
  expect((await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin).toMatchObject({
    data_schema: 3,
    stored_data_schema: 3,
  })

  // Going back to schema 2 is now refused too; generation before+1 keeps serving.
  at = await lastReloadAt(profile, pluginId)
  await editManifest(source, (next) => {
    next.data_schema = 2
  })
  expect(await nextReload(profile, pluginId, at)).toMatchObject({
    status: 'refused',
    message: expect.stringContaining('Plugin data is at schema 3; the source declares 2'),
  })
  expect(await current(profile, pluginId)).toBe(before + 1)
  expect(await echoed(profile, pluginId)).toMatchObject({ value: { version: 'v3', generation: before + 1 } })
})

test('development mode accepts only an enabled plugin from a local directory, with a bounded debounce; disabling ends it', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId } = await installAndEnable(profile, source)
  for (const debounce of [49, 10_001]) {
    await expect(
      profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: debounce }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('debounce_ms must be 50 to 10000'),
    })
  }
  // The default debounce applies when none is given; entering again only retunes it.
  expect((await profile.call('plugin.dev.enter', { plugin_id: pluginId })).dev).toMatchObject({
    debounce_ms: 300,
    watching: true,
  })
  expect((await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 120 })).dev).toMatchObject({
    debounce_ms: 120,
    watching: true,
    source_path: source,
  })

  // Disabling ends development mode, and enabling again does not resume it.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect((await generations(profile, pluginId)).dev).toBeNull()
  await expect(profile.call('plugin.dev.enter', { plugin_id: pluginId })).rejects.toMatchObject({
    code: 'invalid_request',
    message: expect.stringContaining('is not enabled'),
  })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  expect((await generations(profile, pluginId)).dev).toBeNull()

  // A plugin installed from a package archive has no source directory to watch.
  const packaged = await stagePlugin(ade.root, 'backend')
  await editManifest(packaged, (next) => {
    next.id = 'e2e.packed'
    const contributes = next.contributes as { commands: Array<{ id: string }> }
    for (const command of contributes.commands) command.id = command.id.replace('e2e.backend.', 'e2e.packed.')
  })
  await mkdir(join(ade.root, 'pack'), { recursive: true })
  await cp(packaged, join(ade.root, 'pack', 'package'), { recursive: true })
  const archive = join(ade.root, 'packed.tgz')
  await execFileAsync('tar', ['-czf', archive, '-C', join(ade.root, 'pack'), 'package'])
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  await profile.call('plugin.install', { operation_id: 'packed', source: { kind: 'package', path: archive, sha256 } })
  await profile.call('plugin.enable', { plugin_id: 'e2e.packed' })
  await expect(profile.call('plugin.dev.enter', { plugin_id: 'e2e.packed' })).rejects.toMatchObject({
    code: 'invalid_request',
    message: expect.stringContaining('development mode needs a local directory'),
  })
})

test('a source that never goes quiet still reloads at the 10 s cap, and a retuned debounce applies at once', async ({
  ade,
  profile,
}) => {
  test.setTimeout(90_000)
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId } = await installAndEnable(profile, source)
  // With the longest debounce, the quiet period can never elapse while the source keeps changing.
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 10_000 })
  expect(await nextReload(profile, pluginId, 0, 20_000)).toMatchObject({ status: 'unchanged' })
  const before = await current(profile, pluginId)

  let writes = 0
  let completedWrites = 0
  let writing = true
  const started = Date.now()
  const writer = (async () => {
    while (writing) {
      await setVersion(source, `w${++writes}`)
      completedWrites = writes
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  })()
  try {
    await expect.poll(async () => (await generations(profile, pluginId)).dev?.reload_due_at ?? 0).toBeGreaterThan(0)
    const due = (await generations(profile, pluginId)).dev?.reload_due_at ?? 0
    expect(due - started).toBeLessThanOrEqual(10_000 + 1_000)
    await expect.poll(() => current(profile, pluginId), { timeout: 30_000, intervals: [25] }).toBe(before + 1)
    // Keep writing through publication. A completed write after the committed
    // generation must remain pending, regardless of when the query was sampled.
    const writesAtCommit = writes
    await expect.poll(() => completedWrites, { intervals: [25] }).toBeGreaterThan(writesAtCommit)
  } finally {
    writing = false
    await writer
  }
  const elapsed = Date.now() - started
  // It fired at the cap, while writes were still arriving, not after a quiet period.
  expect(elapsed).toBeGreaterThanOrEqual(9_000)
  const partial = await echoed(profile, pluginId)
  expect(partial.value.version).toMatch(/^w\d+$/)
  expect(partial.value.version).not.toBe(`w${writes}`)
  await expect.poll(async () => (await generations(profile, pluginId)).dev?.reload_due_at ?? 0).toBeGreaterThan(0)
  expect((await echoed(profile, pluginId)).value.version).toBe(partial.value.version)

  // Entering again retunes the debounce; the settled source reloads promptly.
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  await expect.poll(() => current(profile, pluginId), { timeout: 15_000 }).toBe(before + 2)
  expect((await echoed(profile, pluginId)).value.version).toBe(`w${writes}`)
})

test('a source directory that disappears is reported as a watch error while the current generation serves; its return reloads', async ({
  ade,
  profile,
}) => {
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  expect(await nextReload(profile, pluginId, 0)).toMatchObject({ status: 'unchanged' })
  const before = await current(profile, pluginId)

  await rename(source, `${source}.away`)
  await expect
    .poll(async () => (await generations(profile, pluginId)).dev?.watch_error ?? '')
    .toContain('Could not read')
  expect(await echoed(profile, pluginId)).toMatchObject({ value: { version: 'v1', generation: before } })
  expect((await generations(profile, pluginId)).dev).toMatchObject({ watching: true })

  await rename(`${source}.away`, source)
  await setVersion(source, 'v2')
  await expect
    .poll(async () => (await echoed(profile, pluginId)).value, { timeout: 20_000 })
    .toMatchObject({ version: 'v2', generation: before + 1 })
  expect((await generations(profile, pluginId)).dev?.watch_error).toBeNull()
})
