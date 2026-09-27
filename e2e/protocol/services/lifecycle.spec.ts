// F086 managed dev services: configure, start, readiness, logs, health, stop,
// duplicate requests, edit and remove fences, and a service that outlives its
// daemon (the process that stands in for the UI) across graceful and killed
// restarts.
import { expect, isRunning, test } from '../fixtures'
import {
  configureService,
  httpGet,
  inspectService,
  logText,
  nodeService,
  serviceState,
  waitForReadiness,
  writeServicePrograms,
} from '../fixtures/services'

test('a configured HTTP service starts, reports readiness, logs and health, and stops with its port free', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const config = nodeService(files.server, {
    env: { GREETING: 'hello' },
    health: { port_variable: 'PORT', path: '/health', timeout_ms: 500, interval_ms: 1_000 },
  })
  const configured = await configureService(profile, workspace.id, 'web', config)
  expect(configured).toMatchObject({ name: 'web', revision: 1, terminal_owner: null })
  const port = configured.ports.PORT
  expect(port).toBeGreaterThanOrEqual(20_000)
  expect(configured.hostname).toMatch(/^web-[0-9a-f]{12}\.localhost$/)

  // The same configuration again converges on the stored service.
  const again = await profile.call('service.configure', {
    workspace_id: workspace.id,
    name: 'web',
    revision: 0,
    config,
  })
  expect(again.service).toEqual(configured)
  expect(await serviceState(profile, workspace.id, 'web')).toBe('stopped')
  expect((await inspectService(profile, workspace.id, 'web')).readiness.state).toBe('stopped')

  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  expect(started.terminal_id).toBeTruthy()
  expect(started.service.terminal_owner?.runtime_instance).toBe(profile.hello.runtime_instance)
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  expect(await isRunning(shellPid)).toBe(true)

  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const inspection = await inspectService(profile, workspace.id, 'web')
  expect(inspection.execution_state).toBe('running')
  expect(inspection.readiness).toMatchObject({ basis: 'direct_process_tcp_listener', application_ready: 'unverified' })

  const direct = await httpGet(`http://127.0.0.1:${port}/hello`)
  expect(direct.status).toBe(200)
  expect(direct.json).toMatchObject({ service: 'web', pid: shellPid, port, path: '/hello' })

  // Output reaches both the live tail and the durable run log.
  await expect
    .poll(async () => logText((await inspectService(profile, workspace.id, 'web')).logs))
    .toContain(`listening on ${port}`)
  await expect
    .poll(async () => logText((await inspectService(profile, workspace.id, 'web')).durable_logs))
    .toContain(`listening on ${port}`)

  const probed = await profile.call('service.inspect', {
    workspace_id: workspace.id,
    name: 'web',
    health_check: { port_variable: 'PORT', path: '/health', timeout_ms: 1_000 },
  })
  expect(probed.health).toMatchObject({ state: 'healthy', basis: 'http_status', status_code: 200 })
  const sample = await profile.call('service.health.sample', { workspace_id: workspace.id, name: 'web' })
  expect(sample.health_monitor).toMatchObject({ state: 'healthy', status_code: 200 })

  // listener.list attributes the listener to this managed service.
  const listeners = await profile.call('listener.list', {})
  expect(listeners.listeners.find((row) => row.port === port)).toMatchObject({
    pid: shellPid,
    ownership: 'managed_service',
    workspace_id: workspace.id,
    service_name: 'web',
  })
  expect(listeners.assignments.find((row) => row.port === port)).toMatchObject({
    service_name: 'web',
    variable: 'PORT',
    observation: 'verified_managed',
  })

  // A running service cannot be edited or removed.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'web',
      revision: 1,
      config: { ...config, env: { GREETING: 'changed' } },
    }),
  ).rejects.toThrow(/Stop the service before editing it/)
  await expect(
    profile.call('service.remove', { workspace_id: workspace.id, name: 'web', revision: 1 }),
  ).rejects.toThrow(/Stop the service before removing it/)

  const stopped = await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(stopped.service.terminal_owner).toBeNull()
  expect(await isRunning(shellPid)).toBe(false)
  expect(await serviceState(profile, workspace.id, 'web')).toBe('stopped')
  const after = await inspectService(profile, workspace.id, 'web')
  expect(after.readiness.state).toBe('stopped')
  expect(after.health_monitor).toMatchObject({ state: 'not_running' })
  // The durable log keeps the stopped run's output.
  expect(logText(after.durable_logs)).toContain(`listening on ${port}`)
  await expect(httpGet(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  expect((await profile.call('listener.list', {})).assignments.find((row) => row.port === port)).toMatchObject({
    observation: 'unobserved',
  })

  // A second stop converges on the stopped service.
  const repeated = await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(repeated.service.terminal_owner).toBeNull()

  // Edits and removal work once stopped, and a stale revision is refused.
  const edited = await profile.call('service.configure', {
    workspace_id: workspace.id,
    name: 'web',
    revision: 1,
    config: { ...config, env: { GREETING: 'changed' } },
  })
  expect(edited.service).toMatchObject({ revision: 2, identity: configured.identity, ports: { PORT: port } })
  await expect(
    profile.call('service.remove', { workspace_id: workspace.id, name: 'web', revision: 1 }),
  ).rejects.toThrow(/Service changed; reload before removing/)
  await profile.call('service.remove', { workspace_id: workspace.id, name: 'web', revision: 2 })
  expect((await profile.call('service.list', { workspace_id: workspace.id })).services).toEqual([])
})

test('a duplicate start returns the live run instead of launching a second one', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'api', nodeService(files.server))

  const [first, second] = await Promise.allSettled([
    profile.call('service.start', { workspace_id: workspace.id, name: 'api' }),
    profile.call('service.start', { workspace_id: workspace.id, name: 'api' }),
  ])
  // Concurrent starts: one launches; the other either returns that run or is
  // refused as in progress. Neither launches a second process.
  const fulfilled = [first, second].filter((result) => result.status === 'fulfilled')
  expect(fulfilled.length).toBeGreaterThanOrEqual(1)
  for (const result of [first, second]) {
    if (result.status === 'rejected') expect(String(result.reason)).toMatch(/Service start is already in progress/)
  }
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  const running = (await profile.call('service.list', { workspace_id: workspace.id })).services[0]

  const repeated = await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  expect(repeated.service.terminal_owner).toEqual(running.terminal_owner)
  const owners = new Set(fulfilled.map((result) => JSON.stringify(result.value.service.terminal_owner)))
  expect(owners).toEqual(new Set([JSON.stringify(running.terminal_owner)]))
  const listeners = (await profile.call('listener.list', {})).listeners.filter((row) => row.port === running.ports.PORT)
  expect(new Set(listeners.map((row) => row.pid)).size).toBe(1)

  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
})

test('the CLI configures, starts, inspects and stops a service', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const configured = await profile.cli(
    'service',
    'configure',
    workspace.id,
    'cli-web',
    JSON.stringify(nodeService(files.server)),
  )
  expect(configured.code).toBe(0)
  const port = (configured.json as { service: { ports: { PORT: number } } }).service.ports.PORT

  expect((await profile.cli('service', 'start', workspace.id, 'cli-web')).code).toBe(0)
  await waitForReadiness(profile, workspace.id, 'cli-web', 'tcp_listening')
  const listed = await profile.cli('service', 'list', workspace.id)
  expect(listed.json).toMatchObject({ type: 'services', states: { 'cli-web': { state: 'running' } } })
  const inspected = await profile.cli('service', 'inspect', workspace.id, 'cli-web')
  expect(inspected.json).toMatchObject({ type: 'service_inspection', readiness: { state: 'tcp_listening' } })
  const listeners = await profile.cli('listener', 'list')
  expect(JSON.stringify(listeners.json)).toContain(`"port":${port}`)

  expect((await profile.cli('service', 'stop', workspace.id, 'cli-web')).code).toBe(0)
  expect(await serviceState(profile, workspace.id, 'cli-web')).toBe('stopped')
  const missing = await profile.cli('service', 'start', workspace.id, 'no-such-service')
  expect(missing.code).not.toBe(0)
  expect(missing.json).toMatchObject({ type: 'error' })
})

for (const mode of ['graceful', 'kill'] as const) {
  test(`a running service survives a ${mode} daemon restart and still stops cleanly`, async ({ profile, repo }) => {
    const { workspace } = await profile.call('workspace.open', { path: repo.path })
    const files = await writeServicePrograms(repo.path)
    const service = await configureService(profile, workspace.id, 'web', nodeService(files.server))
    const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
    const shellPid = (started.metrics as { shell_pid: number }).shell_pid
    await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

    const before = profile.hello
    const after = await profile.restartDaemon(mode)
    expect(after.boot_id).not.toBe(before.boot_id)
    expect(after.runtime_instance).toBe(before.runtime_instance)

    expect(await isRunning(shellPid)).toBe(true)
    expect(await serviceState(profile, workspace.id, 'web')).toBe('running')
    await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
    const reply = await httpGet(`http://127.0.0.1:${service.ports.PORT}/`)
    expect(reply.json).toMatchObject({ service: 'web', pid: shellPid })
    // The start is idempotent across the restart: the same run comes back.
    const repeated = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
    expect(repeated.service.terminal_owner).toEqual(started.service.terminal_owner)

    // The port claim taken by the previous daemon is still held for the run.
    expect(
      (await profile.call('resources.inspect', { resource: 'port' })).claims.filter(
        (claim) => claim.port === service.ports.PORT,
      ),
    ).toHaveLength(1)

    await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
    expect(await isRunning(shellPid)).toBe(false)
    expect(await serviceState(profile, workspace.id, 'web')).toBe('stopped')
    // The new daemon's verified stop settles the claim its predecessor took.
    expect(
      (await profile.call('resources.inspect', { resource: 'port' })).claims.filter(
        (claim) => claim.port === service.ports.PORT,
      ),
    ).toEqual([])
  })
}

test('a configured health policy is sampled without being asked and follows the run', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(
    profile,
    workspace.id,
    'web',
    nodeService(files.server, {
      health: { port_variable: 'PORT', path: '/health', timeout_ms: 200, interval_ms: 500 },
    }),
  )
  expect((await inspectService(profile, workspace.id, 'web')).health_monitor).toMatchObject({ state: 'not_running' })
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await expect
    .poll(
      async () => ((await inspectService(profile, workspace.id, 'web')).health_monitor as { state: string }).state,
      { timeout: 15_000 },
    )
    .toBe('healthy')
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect((await inspectService(profile, workspace.id, 'web')).health_monitor).toMatchObject({ state: 'not_running' })
  // A service without a policy has no monitor to sample.
  await configureService(profile, workspace.id, 'plain', nodeService(files.server))
  await expect(profile.call('service.health.sample', { workspace_id: workspace.id, name: 'plain' })).rejects.toThrow(
    /Service has no configured HTTP health policy/,
  )
})
