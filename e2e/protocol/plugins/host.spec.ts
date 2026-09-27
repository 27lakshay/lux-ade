// Backend plugin hosts (F057): a headless Node host per activation, crash
// supervision with bounded backoff, and a core that stays available.
import { expect, isRunning, test, type ScratchProfile } from '../fixtures'
import { processTable } from '../fixtures/processes'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'

let operations = 0
const echo = 'e2e.backend.echo'

function invoke(
  profile: ScratchProfile,
  pluginId: string,
  commandId: string,
  args: unknown = null,
  operationId = `invoke-${process.pid}-${++operations}`,
) {
  return profile.call('plugin.command.invoke', {
    operation_id: operationId,
    plugin_id: pluginId,
    command_id: commandId,
    args,
  })
}

async function hostStatus(profile: ScratchProfile, pluginId: string) {
  return (await profile.call('plugin.host.status', { plugin_id: pluginId })).host
}

/** Wait for the supervisor to bring a host back after a crash, and return its status. */
async function waitForRunning(profile: ScratchProfile, pluginId: string, attempt: number, timeout = 10_000) {
  await expect
    .poll(
      async () => {
        const host = await hostStatus(profile, pluginId)
        return `${host.state}:${host.attempt}`
      },
      { timeout },
    )
    .toBe(`running:${attempt}`)
  return hostStatus(profile, pluginId)
}

test('runs backend commands in a headless host with settings, replays by operation ID and reports failures', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  // The host starts lazily, on the first invocation.
  expect(await hostStatus(profile, pluginId)).toMatchObject({ state: 'idle', pid: null })

  const first = await invoke(profile, pluginId, echo, { x: 1 }, 'echo-1')
  expect(first).toMatchObject({
    plugin_id: pluginId,
    command_id: echo,
    generation: 1,
    attempt: 1,
    outcome: { status: 'completed', value: { args: { x: 1 }, version: 'v1', generation: 1 } },
  })
  const value = (first.outcome as { value: { pid: number } }).value
  const host = await hostStatus(profile, pluginId)
  expect(host).toMatchObject({ state: 'running', generation: 1, pid: value.pid, crashes: 0 })
  // A plain Node process running the headless host, not Electron.
  const row = (await processTable()).find((candidate) => candidate.pid === value.pid)
  expect(row?.command).toMatch(/packages\/plugin-host\/src\/host\.mjs/)
  expect(row?.command).not.toMatch(/Electron/i)
  // Plugin console output goes to the bounded log tail, never the protocol stream.
  await expect
    .poll(async () => (await hostStatus(profile, pluginId)).log_tail.some((line) => line.includes('fixture echo v1')))
    .toBe(true)
  // The out_dir setting reached activate: the plugin wrote there.
  expect(await pluginLines(outDir, 'lifecycle.jsonl')).toEqual([
    expect.objectContaining({ event: 'activate', generation: 1 }),
  ])

  // A replay returns the stored result; the same ID with other arguments is a conflict.
  expect(await invoke(profile, pluginId, echo, { x: 1 }, 'echo-1')).toEqual(first)
  await expect(invoke(profile, pluginId, echo, { x: 2 }, 'echo-1')).rejects.toMatchObject({ code: 'conflict' })

  expect((await invoke(profile, pluginId, 'e2e.backend.fail')).outcome).toEqual({
    status: 'failed',
    message: expect.stringContaining('fixture command failed'),
  })
  await expect(invoke(profile, pluginId, 'e2e.backend.undeclared')).rejects.toMatchObject({ code: 'invalid_request' })

  // The CLI reaches the same host.
  const cli = await profile.cli(
    'plugin',
    'invoke',
    pluginId,
    echo,
    '--request-id',
    'cli-echo',
    '--args',
    '{"via":"cli"}',
  )
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ outcome: { status: 'completed', value: { args: { via: 'cli' }, pid: value.pid } } })

  // Disable runs the plugin's deactivate and leaves no host process.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await expect.poll(() => isRunning(value.pid)).toBe(false)
  expect((await pluginLines(outDir, 'lifecycle.jsonl')).map((line) => line.event)).toEqual(['activate', 'deactivate'])
  await expect(invoke(profile, pluginId, echo)).rejects.toMatchObject({ code: 'invalid_request' })
})

test('a crashing host keeps the core available, restarts after 500 ms, 2 s and 5 s, then stays errored', async ({
  ade,
  profile,
}) => {
  test.setTimeout(90_000)
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  await invoke(profile, pluginId, echo)

  const delays = [500, 2_000, 5_000]
  for (const [index, delay] of delays.entries()) {
    const crashId = `crash-${index + 1}`
    // The handler may have run: the outcome is unknown, and a replay never runs it again.
    await expect(invoke(profile, pluginId, 'e2e.backend.crash', null, crashId)).rejects.toMatchObject({
      code: 'outcome_unknown',
    })
    await expect(invoke(profile, pluginId, 'e2e.backend.crash', null, crashId)).rejects.toMatchObject({
      code: 'outcome_unknown',
    })
    expect((await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === 'crash')).toHaveLength(
      index + 1,
    )

    const down = await hostStatus(profile, pluginId)
    expect(down.crashes).toBe(index + 1)
    // The 500 ms restart may already have happened; the longer ones cannot have.
    if (delay >= 2_000) {
      expect(down.state).toBe('backoff')
      expect((down.retry_at ?? 0) - Date.now()).toBeGreaterThan(delay - 1_500)
    }
    if (down.state === 'backoff') {
      // The restart is scheduled no later than the schedule allows.
      expect((down.retry_at ?? 0) - Date.now()).toBeLessThanOrEqual(delay)
      if (delay >= 2_000) {
        // During backoff an invocation is refused before any plugin code runs.
        await expect(invoke(profile, pluginId, echo)).rejects.toMatchObject({ code: 'not_applied' })
      }
    }
    // The core stays available while the host is down.
    expect((await profile.call('plugin.list', {})).plugins[0]).toMatchObject({ id: pluginId, status: 'enabled' })
    await profile.call('plugin.record.put', { plugin_id: pluginId, namespace: 'core', key: `k${index}`, value: index })

    const started = Date.now()
    const back = await waitForRunning(profile, pluginId, index + 2)
    expect(back.started_at ?? 0).toBeGreaterThanOrEqual(started - delay)
  }

  // A fourth consecutive crash leaves the host errored until an explicit restart.
  await expect(invoke(profile, pluginId, 'e2e.backend.crash', null, 'crash-4')).rejects.toMatchObject({
    code: 'outcome_unknown',
  })
  await expect.poll(async () => (await hostStatus(profile, pluginId)).state).toBe('errored')
  const errored = await hostStatus(profile, pluginId)
  expect(errored).toMatchObject({ crashes: 4, pid: null, retry_at: null })
  const refused = await invoke(profile, pluginId, echo).then(
    () => null,
    (error: unknown) => error as { code: string; message: string },
  )
  expect(refused?.code).toBe('not_applied')
  expect(refused?.message).toMatch(/restart/i)
  expect((await profile.call('plugin.record.list', { plugin_id: pluginId, namespace: 'core' })).records).toHaveLength(3)

  const restarted = (await profile.call('plugin.host.restart', { plugin_id: pluginId })).host
  expect(restarted).toMatchObject({ state: 'running', crashes: 0 })
  expect((await invoke(profile, pluginId, echo, 'after')).outcome).toMatchObject({
    status: 'completed',
    value: { args: 'after' },
  })
})

test('a host killed from outside counts as a crash, and a killed daemon takes its hosts with it', async ({
  ade,
  profile,
}) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const first = (await invoke(profile, pluginId, echo)).outcome as { value: { pid: number } }
  process.kill(first.value.pid, 'SIGKILL')
  await expect.poll(async () => (await hostStatus(profile, pluginId)).crashes).toBe(1)
  const restarted = await waitForRunning(profile, pluginId, 2)
  expect(restarted.pid).not.toBe(first.value.pid)
  const second = (await invoke(profile, pluginId, echo)).outcome as { value: { pid: number } }
  expect(second.value.pid).toBe(restarted.pid)

  const before = await profile.call('plugin.inspect', { plugin_id: pluginId })
  await profile.killDaemon()
  await expect.poll(() => isRunning(second.value.pid)).toBe(false)
  await profile.restartDaemon()
  const after = await profile.call('plugin.inspect', { plugin_id: pluginId })
  expect(after.plugin.activation_generation).toBeGreaterThan(before.plugin.activation_generation)
  expect(await hostStatus(profile, pluginId)).toMatchObject({ state: 'idle', pid: null })
  const third = await invoke(profile, pluginId, echo)
  expect(third.generation).toBe(after.plugin.activation_generation)
})
