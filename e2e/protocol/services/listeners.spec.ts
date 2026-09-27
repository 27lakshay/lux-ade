// F085 dev port discovery and F087 bind races: listeners are attributed to a
// managed service only through its own process tree; a port a foreign process
// holds is reported as such, never as the service's.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, test } from '../fixtures'
import {
  configureService,
  httpGet,
  inspectService,
  logText,
  nodeService,
  serviceState,
  startForeignListener,
  waitForReadiness,
  writeServicePrograms,
} from '../fixtures/services'

test('listener.list separates managed, discovered and unknown listeners', async ({ ade, profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'web', nodeService(files.server))
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const foreign = await startForeignListener(ade.ledger)
  try {
    const inventory = await profile.call('listener.list', {})
    expect(inventory).toMatchObject({ scope: 'local_host', coverage: 'partial' })
    expect(inventory.listeners.find((row) => row.port === foreign.port)).toMatchObject({
      pid: foreign.pid,
      ownership: 'unknown',
      workspace_id: null,
      service_name: null,
      protocol: 'tcp',
      family: 'ipv4',
    })
    expect(inventory.listeners.find((row) => row.port === service.ports.PORT)).toMatchObject({
      ownership: 'managed_service',
      workspace_id: workspace.id,
      service_name: 'web',
    })
    // Only assigned ports appear as assignments; the foreign port is discovered, not assigned.
    expect(inventory.assignments.map((row) => row.port)).toContain(service.ports.PORT)
    expect(inventory.assignments.map((row) => row.port)).not.toContain(foreign.port)
  } finally {
    await foreign.close()
  }
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a start is refused while a foreign process holds the assigned port', async ({ ade, profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const foreign = await startForeignListener(ade.ledger, service.ports.PORT)
  try {
    await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'web' })).rejects.toThrow(
      new RegExp(`Service port PORT=${service.ports.PORT} is in use`),
    )
    expect(await serviceState(profile, workspace.id, 'web')).toBe('stopped')
    // The assignment is never silently remapped.
    expect((await profile.call('service.list', { workspace_id: workspace.id })).services[0].ports).toEqual(
      service.ports,
    )
    expect(
      (await profile.call('listener.list', {})).assignments.find((row) => row.port === service.ports.PORT),
    ).toMatchObject({ service_name: 'web', observation: 'observed_other' })
    // No port claim is left behind by the refused start.
    const claims = await profile.call('resources.inspect', { resource: 'port' })
    expect(claims.claims.filter((claim) => claim.port === service.ports.PORT)).toEqual([])
  } finally {
    await foreign.close()
  }
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a foreign process that wins the bind race is reported as a port conflict and keeps the claim quarantined', async ({
  ade,
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const gate = join(ade.root, 'bind-gate')
  const service = await configureService(
    profile,
    workspace.id,
    'web',
    nodeService(files.server, { env: { E2E_GATE: gate } }),
  )
  const port = service.ports.PORT
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  await expect
    .poll(async () => logText((await inspectService(profile, workspace.id, 'web')).logs))
    .toContain('waiting for gate')
  expect((await inspectService(profile, workspace.id, 'web')).readiness.state).toBe('not_observed')

  // The port is free between the start's check and the service's bind; a foreign process takes it.
  const foreign = await startForeignListener(ade.ledger, port)
  try {
    await writeFile(gate, '')
    await expect
      .poll(async () => logText((await inspectService(profile, workspace.id, 'web')).logs))
      .toContain('bind failed: EADDRINUSE')
    await waitForReadiness(profile, workspace.id, 'web', 'port_conflict')
    const probed = await profile.call('service.inspect', {
      workspace_id: workspace.id,
      name: 'web',
      health_check: { port_variable: 'PORT', path: '/', timeout_ms: 500 },
    })
    expect(probed.execution_state).toBe('running')
    expect(probed.health).toMatchObject({ state: 'unhealthy', basis: 'port_taken_by_other_process' })
    const inventory = await profile.call('listener.list', {})
    expect(inventory.assignments.find((row) => row.port === port)).toMatchObject({ observation: 'observed_other' })
    expect(inventory.listeners.find((row) => row.port === port)).toMatchObject({
      pid: foreign.pid,
      ownership: 'unknown',
    })

    // The stable URL refuses to forward to the foreign holder.
    const route = await profile.call('service.proxy.ensure', {
      workspace_id: workspace.id,
      name: 'web',
      port_variable: 'PORT',
    })
    const proxied = await httpGet(route.url!)
    expect(proxied.status).toBe(503)
    expect(proxied.text).not.toContain('foreign')

    // Stop proves the run exited, but a listener is still on the port, so the claim is quarantined, not released.
    await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
    expect(await isRunning(shellPid)).toBe(false)
    const claims = (await profile.call('resources.inspect', { resource: 'port' })).claims.filter(
      (claim) => claim.port === port,
    )
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ resource: 'port', path: `tcp:${port}`, state: 'quarantined' })
  } finally {
    await foreign.close()
  }

  // Once the port is free, the next start of the same service supersedes its own quarantined claim.
  await profile.call('service.configure', {
    workspace_id: workspace.id,
    name: 'web',
    revision: 1,
    config: nodeService(files.server),
  })
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const active = (await profile.call('resources.inspect', { resource: 'port' })).claims.filter(
    (claim) => claim.port === port,
  )
  expect(active).toHaveLength(1)
  expect(active[0]).toMatchObject({ state: 'active', mine: true })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(
    (await profile.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port),
  ).toEqual([])
})

test('a service that loses the bind and falls back to another port is bound_unassigned_port, not ready', async ({
  ade,
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const gate = join(ade.root, 'bind-gate')
  const service = await configureService(
    profile,
    workspace.id,
    'vite',
    nodeService(files.server, { env: { E2E_GATE: gate, E2E_ON_BIND_FAIL: 'fallback' } }),
  )
  await profile.call('service.start', { workspace_id: workspace.id, name: 'vite' })
  await expect
    .poll(async () => logText((await inspectService(profile, workspace.id, 'vite')).logs))
    .toContain('waiting for gate')
  const foreign = await startForeignListener(ade.ledger, service.ports.PORT)
  try {
    await writeFile(gate, '')
    await expect
      .poll(async () => logText((await inspectService(profile, workspace.id, 'vite')).logs))
      .toContain('falling back')
    // While the foreign process holds the assigned port, that is the conflict reported.
    await waitForReadiness(profile, workspace.id, 'vite', 'port_conflict')
  } finally {
    await foreign.close()
  }
  // The assigned port is free again, but the service already bound another one.
  await waitForReadiness(profile, workspace.id, 'vite', 'bound_unassigned_port')
  const probed = await profile.call('service.inspect', {
    workspace_id: workspace.id,
    name: 'vite',
    health_check: { port_variable: 'PORT', path: '/', timeout_ms: 500 },
  })
  expect(probed.health).toMatchObject({ state: 'unhealthy', basis: 'assigned_port_not_bound' })
  // The fallback listener is still the service's own, and the assignment is unchanged.
  const inventory = await profile.call('listener.list', {})
  const own = inventory.listeners.filter((row) => row.service_name === 'vite')
  expect(own.length).toBeGreaterThan(0)
  expect(own.every((row) => row.port !== service.ports.PORT)).toBe(true)
  expect(inventory.assignments.find((row) => row.service_name === 'vite')).toMatchObject({
    port: service.ports.PORT,
    observation: 'unobserved',
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'vite' })
})

test('a wrapper whose child binds is ready through its process tree and proxied', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'dev', nodeService(files.wrapper))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'dev' })
  const wrapperPid = (started.metrics as { shell_pid: number }).shell_pid
  await waitForReadiness(profile, workspace.id, 'dev', 'tcp_listening')
  const inspection = await inspectService(profile, workspace.id, 'dev')
  expect(inspection.readiness.basis).toBe('process_tree_tcp_listener')
  const row = (await profile.call('listener.list', {})).listeners.find((entry) => entry.port === service.ports.PORT)
  expect(row).toMatchObject({ ownership: 'managed_service', service_name: 'dev' })
  expect(row!.pid).not.toBe(wrapperPid)

  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'dev',
    port_variable: 'PORT',
  })
  const reply = await httpGet(`${route.url}tree`)
  expect(reply.status).toBe(200)
  expect(reply.json).toMatchObject({ service: 'dev', pid: row!.pid, path: '/tree' })

  await profile.call('service.stop', { workspace_id: workspace.id, name: 'dev' })
  expect(await isRunning(row!.pid)).toBe(false)
})
