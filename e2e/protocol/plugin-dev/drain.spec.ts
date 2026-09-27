// Bounded drain (F060, F139 backend part). A development-mode reload hands the
// superseded backend host to a drain: its open calls may finish for at most
// 15 s. A call still open when that grace ends is cut off and settles as
// `outcome_unknown`, never as done, and a replay never runs it again. While
// a superseded host drains, its artifact stays and the plugin cannot be
// uninstalled. `plugins/dev-reload.spec.ts` proves the drain whose call
// finishes inside the grace.
import { existsSync } from 'node:fs'
import { expect, isRunning, test } from '../fixtures'
import { stageFaultyPlugin } from '../fixtures/faulty-plugin'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'
import { current, echoed, editFile, generations, invoke, setVersion, states } from './dev'

const GRACE_MS = 15_000

test('a call still open when the drain grace ends is cut off as outcome_unknown and never rerun; uninstall waits for the drain', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const source = await stagePlugin(ade.root, 'backend')
  const { pluginId, outDir } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = await current(profile, pluginId)
  const old = await echoed(profile, pluginId)
  const oldArtifact = (await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.artifact_path

  // This call is never released: only the drain grace can end it.
  const held = invoke(profile, pluginId, 'e2e.backend.hold', { release: 'never' }, 'held-forever').then(
    (reply) => ({ reply }),
    (error: unknown) => ({ error }),
  )
  await expect
    .poll(async () => (await pluginLines(outDir, 'lifecycle.jsonl')).some((line) => line.event === 'hold-started'))
    .toBe(true)
  const edited = Date.now()
  await setVersion(source, 'v2')
  await expect
    .poll(() => states(profile, pluginId), { timeout: 20_000 })
    .toEqual([`${before}:draining`, `${before + 1}:current`])
  expect((await profile.call('plugin.host.status', { plugin_id: pluginId })).host.log_tail).toContain(
    `[ade] generation ${before} superseded; draining 1 open call(s)`,
  )
  // New work is served by the new generation while the old host drains.
  expect(await echoed(profile, pluginId)).toMatchObject({
    status: 'completed',
    value: { version: 'v2', generation: before + 1 },
  })
  expect(await isRunning(old.value.pid)).toBe(true)

  // A draining host still runs from its artifact, so uninstall is refused until it stops.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect(existsSync(oldArtifact)).toBe(true)
  await expect(
    profile.call('plugin.uninstall', { operation_id: 'uninstall-draining', plugin_id: pluginId }),
  ).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/still draining/) })

  // The grace ends: the call is cut off with an unknown outcome, and the old host stops.
  const settled = await held
  expect(Date.now() - edited).toBeGreaterThanOrEqual(GRACE_MS)
  expect(settled).toMatchObject({ error: { code: 'outcome_unknown' } })
  await expect.poll(() => isRunning(old.value.pid)).toBe(false)
  // The plugin's deactivate still ran, after the call it cut off started.
  const events = (await pluginLines(outDir, 'lifecycle.jsonl')).map((line) => `${line.event}:${line.version}`)
  expect(events.indexOf('deactivate:v1')).toBeGreaterThan(events.indexOf('hold-started:v1'))

  // A replay reports the unknown outcome and never runs the handler again.
  await profile.call('plugin.enable', { plugin_id: pluginId })
  await expect(
    invoke(profile, pluginId, 'e2e.backend.hold', { release: 'never' }, 'held-forever'),
  ).rejects.toMatchObject({ code: 'outcome_unknown' })
  expect((await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === 'hold-started')).toHaveLength(1)
  expect((await profile.call('plugin.host.status', { plugin_id: pluginId })).host.log_tail).toContain(
    `[ade] generation ${before} drain grace ended with 1 open call(s); their outcome is unknown`,
  )

  // Nothing holds the old generation now: it retires and its artifact is removed.
  await expect
    .poll(
      async () =>
        (await generations(profile, pluginId)).generations.find((generation) => generation.generation === before)
          ?.state,
    )
    .toBe('retired')
  expect(existsSync(oldArtifact)).toBe(false)
  await profile.call('plugin.disable', { plugin_id: pluginId })
  const uninstalled = await profile.call('plugin.uninstall', { operation_id: 'uninstall-drained', plugin_id: pluginId })
  expect(uninstalled.type).toBeTruthy()
})

test('the drain stays bounded when the superseded host is frozen and cannot answer deactivate', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const source = await stageFaultyPlugin(ade.root)
  const { pluginId, outDir } = await installAndEnable(profile, source)
  await profile.call('plugin.dev.enter', { plugin_id: pluginId, debounce_ms: 100 })
  const before = await current(profile, pluginId)
  const old = (await invoke(profile, pluginId, 'e2e.faulty.echo')).outcome as { value: { pid: number } }

  // The freeze blocks the old host's event loop: it can neither finish the call nor run deactivate.
  const frozen = invoke(profile, pluginId, 'e2e.faulty.freeze', null, 'frozen-drain').then(
    (reply) => ({ reply }),
    (error: unknown) => ({ error }),
  )
  await expect
    .poll(async () => (await pluginLines(outDir, 'lifecycle.jsonl')).some((line) => line.event === 'freeze'))
    .toBe(true)
  await editFile(source, 'backend.mjs', (text) => `${text}\n// edited\n`)
  await expect
    .poll(() => states(profile, pluginId), { timeout: 20_000 })
    .toEqual([`${before}:draining`, `${before + 1}:current`])
  const fresh = (await invoke(profile, pluginId, 'e2e.faulty.echo')).outcome as {
    value: { pid: number; generation: number }
  }
  expect(fresh.value).toMatchObject({ generation: before + 1 })
  expect(fresh.value.pid).not.toBe(old.value.pid)

  // Grace (15 s) plus the deactivate bound (5 s): the old host is stopped, and the call is unknown.
  expect(await frozen).toMatchObject({ error: { code: 'outcome_unknown' } })
  await expect.poll(() => isRunning(old.value.pid), { timeout: 30_000 }).toBe(false)
  await expect
    .poll(
      async () =>
        (await generations(profile, pluginId)).generations.find((generation) => generation.generation === before)
          ?.state,
      { timeout: 30_000 },
    )
    .toBe('retired')
  expect((await invoke(profile, pluginId, 'e2e.faulty.echo')).outcome).toMatchObject({
    value: { generation: before + 1, pid: fresh.value.pid },
  })
})
