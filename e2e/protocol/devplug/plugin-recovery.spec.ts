// Plugin development and recovery (F060, F139 backend part; architecture
// "safe mode"). A failing backend plugin is contained: its activation failures
// and crashes count toward a bounded restart schedule, after which it stays
// errored and is never started again on its own. The daemon, its core
// operations and every other plugin keep working, across a daemon restart.
// A frozen host is diagnosed by the health probe and replaced by
// `plugin.host.restart`; the call it froze on settles as `outcome_unknown`.
// The plugin's log is kept as a bounded tail. The faulty plugin fixture fails
// on switch files in its `out_dir`.
import { expect, isRunning, test, type ScratchProfile } from '../fixtures'
import { breakActivation, healActivation, stageFaultyPlugin } from '../fixtures/faulty-plugin'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'

let operations = 0

function invoke(
  profile: ScratchProfile,
  pluginId: string,
  commandId: string,
  args: unknown = null,
  operationId = `recovery-${process.pid}-${++operations}`,
  timeoutMs = 90_000,
) {
  return profile.call(
    'plugin.command.invoke',
    { operation_id: operationId, plugin_id: pluginId, command_id: commandId, args },
    { timeoutMs },
  )
}

async function hostStatus(profile: ScratchProfile, pluginId: string) {
  return (await profile.call('plugin.host.status', { plugin_id: pluginId })).host
}

async function events(outDir: string, name: string): Promise<number> {
  return (await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === name).length
}

/** A healthy plugin beside the faulty one, to show a failure stays contained. */
async function healthyPlugin(ade: { root: string }, profile: ScratchProfile): Promise<string> {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  return pluginId
}

async function expectHealthyCore(profile: ScratchProfile, healthy: string): Promise<void> {
  expect((await invoke(profile, healthy, 'e2e.backend.echo', { ok: true })).outcome).toMatchObject({
    status: 'completed',
  })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  expect(workspace.id).toBeTruthy()
  expect((await profile.call('plugin.list', {})).plugins.map((plugin) => plugin.id).sort()).toEqual(
    expect.arrayContaining([healthy, 'e2e.faulty']),
  )
}

test('safe mode: a backend whose activation keeps failing ends errored after bounded restarts; the core and other plugins keep working, across a daemon restart', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const healthy = await healthyPlugin(ade, profile)
  const { pluginId, outDir } = await installAndEnable(profile, await stageFaultyPlugin(ade.root))
  await breakActivation(outDir, 'fail-activate')

  // The first use starts the host; activation throws, which counts as a crash.
  await expect(invoke(profile, pluginId, 'e2e.faulty.echo')).rejects.toThrow(/fixture activation failed/)
  // The supervisor retries on its schedule (500 ms, 2 s, 5 s), then stops for good.
  await expect.poll(async () => (await hostStatus(profile, pluginId)).state, { timeout: 30_000 }).toBe('errored')
  const errored = await hostStatus(profile, pluginId)
  expect(errored).toMatchObject({
    crashes: 4,
    pid: null,
    retry_at: null,
    last_error: expect.stringContaining('fixture activation failed'),
  })
  expect(
    errored.log_tail.some((line) => line.includes('host start failed') && line.includes('fixture activation failed')),
  ).toBe(true)
  expect(await events(outDir, 'activate-failed')).toBe(4)

  // Errored means no further starts: a new call is refused with the recovery step, and nothing activates.
  await expect(invoke(profile, pluginId, 'e2e.faulty.echo')).rejects.toThrow(
    /stays stopped; run `ade plugin host restart e2e\.faulty`/,
  )
  expect(await events(outDir, 'activate-failed')).toBe(4)
  await expectHealthyCore(profile, healthy)
  // The CLI shows the same errored host.
  const cli = await profile.cli('plugin', 'host', 'status', pluginId)
  expect(cli.json).toMatchObject({ host: { state: 'errored', crashes: 4 } })

  // A daemon restart does not start the broken plugin's host: it stays idle until used.
  await profile.restartDaemon('kill')
  expect(await hostStatus(profile, pluginId)).toMatchObject({ state: 'idle', pid: null })
  await expectHealthyCore(profile, healthy)
  expect(await events(outDir, 'activate-failed')).toBe(4)

  // Recovery: fix the cause, then restart the host explicitly.
  await healActivation(outDir, 'fail-activate')
  const restarted = await profile.call('plugin.host.restart', { plugin_id: pluginId })
  expect(restarted.host).toMatchObject({ state: 'running', crashes: 0, last_error: null })
  expect((await invoke(profile, pluginId, 'e2e.faulty.echo', { back: true })).outcome).toMatchObject({
    status: 'completed',
    value: { args: { back: true } },
  })

  // Disabling and re-enabling start a clean activation generation.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await breakActivation(outDir, 'fail-activate')
  await profile.call('plugin.enable', { plugin_id: pluginId })
  await expect(invoke(profile, pluginId, 'e2e.faulty.echo')).rejects.toThrow(/fixture activation failed/)
  await profile.call('plugin.disable', { plugin_id: pluginId })
  // A disabled plugin is never retried: the attempt count stops growing.
  const settled = await events(outDir, 'activate-failed')
  await expect.poll(async () => (await hostStatus(profile, pluginId)).state).toBe('inactive')
  await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  expect(await events(outDir, 'activate-failed')).toBe(settled)
})

test('a host that exits during activation is a crash; a host that hangs in activation is stopped at the deadline', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const healthy = await healthyPlugin(ade, profile)
  const { pluginId, outDir } = await installAndEnable(profile, await stageFaultyPlugin(ade.root))

  await breakActivation(outDir, 'exit-activate')
  await expect(invoke(profile, pluginId, 'e2e.faulty.echo')).rejects.toThrow(/failed to start/)
  await expect.poll(async () => (await hostStatus(profile, pluginId)).state, { timeout: 30_000 }).toBe('errored')
  expect(await events(outDir, 'activate-exit')).toBe(4)
  expect((await hostStatus(profile, pluginId)).log_tail.join('\n')).toContain('fixture activation exits the host')
  await expectHealthyCore(profile, healthy)

  // A hanging activation: the start is abandoned at its deadline and its host killed.
  await healActivation(outDir, 'exit-activate')
  await breakActivation(outDir, 'hang-activate')
  const restart = profile.call('plugin.host.restart', { plugin_id: pluginId }, { timeoutMs: 60_000 })
  await expect.poll(() => events(outDir, 'activate-hang')).toBe(1)
  const hung = (await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === 'activate-hang')[0]
    .pid as number
  // The rest of the daemon answers while the activation hangs, and so does the plugin's own status.
  await expectHealthyCore(profile, healthy)
  const during = await profile.call('plugin.host.status', { plugin_id: pluginId }, { timeoutMs: 5_000 })
  expect(during.host).toMatchObject({ state: 'running', pid: hung, responsive: null })
  expect(during.host.log_tail.at(-1)).toMatch(/waiting for generation \d+ attempt \d+ to activate/)
  await expect(restart).rejects.toMatchObject({ code: 'failed' })
  expect(await isRunning(hung)).toBe(false)
  await healActivation(outDir, 'hang-activate')
  await expect
    .poll(
      async () => {
        const host = await hostStatus(profile, pluginId)
        if (host.state === 'errored') await profile.call('plugin.host.restart', { plugin_id: pluginId })
        return (await hostStatus(profile, pluginId)).state
      },
      { timeout: 30_000 },
    )
    .toBe('running')
  expect((await invoke(profile, pluginId, 'e2e.faulty.echo')).outcome).toMatchObject({ status: 'completed' })
})

test('a frozen host is reported unresponsive and replaced by a restart; the frozen call settles as outcome_unknown', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const healthy = await healthyPlugin(ade, profile)
  const { pluginId, outDir } = await installAndEnable(profile, await stageFaultyPlugin(ade.root))
  const before = (await invoke(profile, pluginId, 'e2e.faulty.echo')).outcome as { value: { pid: number } }
  const frozenPid = before.value.pid

  const frozen = invoke(profile, pluginId, 'e2e.faulty.freeze', null, 'freeze-1').catch((error: unknown) => error)
  await expect.poll(() => events(outDir, 'freeze')).toBe(1)
  // The health probe cannot get an answer; the core and the other plugin still can.
  await expect.poll(async () => (await hostStatus(profile, pluginId)).responsive, { timeout: 20_000 }).toBe(false)
  expect(await hostStatus(profile, pluginId)).toMatchObject({ state: 'running', pid: frozenPid })
  await expectHealthyCore(profile, healthy)

  const restarted = await profile.call('plugin.host.restart', { plugin_id: pluginId }, { timeoutMs: 60_000 })
  expect(restarted.host).toMatchObject({ state: 'running', crashes: 0 })
  expect(restarted.host.pid).not.toBe(frozenPid)
  await expect.poll(() => isRunning(frozenPid)).toBe(false)
  expect(await frozen).toMatchObject({ code: 'outcome_unknown' })
  // The frozen call is never run again under its ID.
  await expect(invoke(profile, pluginId, 'e2e.faulty.freeze', null, 'freeze-1')).rejects.toMatchObject({
    code: 'outcome_unknown',
  })
  expect(await events(outDir, 'freeze')).toBe(1)
  const after = (await invoke(profile, pluginId, 'e2e.faulty.echo')).outcome as { value: { pid: number } }
  expect(after.value.pid).toBe(restarted.host.pid)
  expect((await hostStatus(profile, pluginId)).responsive).toBe(true)
})

test('the plugin log is a bounded tail of whole lines, newest last', async ({ ade, profile }) => {
  const { pluginId } = await installAndEnable(profile, await stageFaultyPlugin(ade.root))
  await invoke(profile, pluginId, 'e2e.faulty.noise', { lines: 1500, width: 4000 })
  await expect
    .poll(async () => (await hostStatus(profile, pluginId)).log_tail.at(-1) ?? '')
    .toMatch(/^noise line 1500 /)
  const tail = (await hostStatus(profile, pluginId)).log_tail
  expect(tail.length).toBeLessThanOrEqual(200)
  expect(tail[0]).not.toMatch(/^noise line 1 /)
  // A long line is cut, not dropped, and never grows the reply without bound.
  for (const line of tail) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048 + 3)
  expect(tail.filter((line) => line.startsWith('noise line')).every((line) => line.endsWith('…'))).toBe(true)
})
