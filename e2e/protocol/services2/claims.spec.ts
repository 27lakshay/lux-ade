// F087 claim timing: a service's port claim is `dispatched` from launch until
// ADE verifies a listener in the service's own process tree, and only then
// `bound` to that listener's PID. A foreign listener, a missing listener or a
// daemon restart never promotes it.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { configureService, httpGet, inspectService, logText, nodeService, serviceNameForPort, startForeignListener,
  waitForReadiness, writeServicePrograms } from '../fixtures/services'

async function portClaims(profile: ScratchProfile, port: number) {
  return (await profile.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port)
}

async function waitForGate(profile: ScratchProfile, workspaceId: string, name: string): Promise<void> {
  await expect.poll(async () => logText((await inspectService(profile, workspaceId, name)).logs)).toContain('waiting for gate')
}

test('a port claim stays dispatched until the listener is verified, then is bound to it', async ({ ade }) => {
  const shared = { ADE_HOST_RESOURCES_HOME: join(ade.root, 'host-resources') }
  const profile = await ade.profile({ env: shared })
  const other = await ade.profile({ env: shared })
  const repo = await ade.repo({ name: 'mine' })
  const otherRepo = await ade.repo({ name: 'theirs' })
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const otherWorkspace = (await other.call('workspace.open', { path: otherRepo.path })).workspace
  const files = await writeServicePrograms(repo.path)
  const otherFiles = await writeServicePrograms(otherRepo.path)
  const gate = join(ade.root, 'gate')
  const theirs = await configureService(other, otherWorkspace.id, 'web', nodeService(otherFiles.server))
  const port = theirs.ports.PORT
  const name = serviceNameForPort(workspace.id, 'PORT', port)
  const service = await configureService(profile, workspace.id, name, nodeService(files.server, { env: { E2E_GATE: gate } }))
  expect(service.ports.PORT).toBe(port)

  // Configuring alone claims nothing.
  expect(await portClaims(profile, port)).toEqual([])
  await profile.call('service.start', { workspace_id: workspace.id, name })
  await waitForGate(profile, workspace.id, name)

  // Launched, not listening: the claim is dispatched and bound to no listener.
  const holder = `service:${workspace.id}/${name}#${service.identity}`
  const [dispatched] = await portClaims(profile, port)
  expect(dispatched).toMatchObject({ phase: 'dispatched', state: 'active', mine: true, holder, mode: 'exclusive',
    path: `tcp:${port}` })
  expect(dispatched.listener_pid).toBeUndefined()
  // Every observation path looks, finds no listener, and leaves it dispatched.
  expect((await inspectService(profile, workspace.id, name)).readiness.state).toBe('not_observed')
  expect((await profile.call('listener.list', {})).assignments.find((row) => row.port === port))
    .toMatchObject({ observation: 'unobserved' })
  expect(await portClaims(profile, port)).toEqual([expect.objectContaining({ id: dispatched.id, phase: 'dispatched' })])
  // Another profile sees the same dispatched claim and is refused the port.
  expect(await portClaims(other, port)).toEqual([expect.objectContaining({ id: dispatched.id, phase: 'dispatched',
    mine: false })])
  await expect(other.call('service.start', { workspace_id: otherWorkspace.id, name: 'web' }))
    .rejects.toThrow(new RegExp(`tcp:${port} conflicts with the active exclusive use claim`))

  // The service binds; the next observation verifies the listener and binds the claim to its PID.
  await writeFile(gate, '')
  await waitForReadiness(profile, workspace.id, name, 'tcp_listening')
  const listenerPid = (await httpGet(`http://127.0.0.1:${port}/`)).json?.pid
  const [bound] = await portClaims(profile, port)
  expect(bound).toMatchObject({ id: dispatched.id, phase: 'bound', state: 'active', mine: true, holder,
    listener_pid: listenerPid })
  expect(bound.updated_at).toBeGreaterThanOrEqual(dispatched.updated_at)
  // Observing again changes nothing.
  await profile.call('listener.list', {})
  expect(await portClaims(profile, port)).toEqual([bound])
  expect(await portClaims(other, port)).toEqual([expect.objectContaining({ id: bound.id, phase: 'bound',
    listener_pid: listenerPid, mine: false })])

  await profile.call('service.stop', { workspace_id: workspace.id, name })
  expect(await portClaims(profile, port)).toEqual([])
  expect(await portClaims(other, port)).toEqual([])
})

test('a wrapper that launches the real server binds the claim to the child that listens', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'dev', nodeService(files.wrapper))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'dev' })
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  await waitForReadiness(profile, workspace.id, 'dev', 'tcp_listening')
  const listenerPid = (await httpGet(`http://127.0.0.1:${service.ports.PORT}/`)).json?.pid
  expect(listenerPid).not.toBe(shellPid)
  expect((await inspectService(profile, workspace.id, 'dev')).readiness.basis).toBe('process_tree_tcp_listener')
  expect(await portClaims(profile, service.ports.PORT)).toEqual([expect.objectContaining({ phase: 'bound',
    listener_pid: listenerPid })])
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'dev' })
  expect(await portClaims(profile, service.ports.PORT)).toEqual([])
})

test('a claim is never bound to a foreign listener that won the bind race', async ({ ade, profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const gate = join(ade.root, 'gate')
  const service = await configureService(profile, workspace.id, 'web', nodeService(files.server, { env: { E2E_GATE: gate } }))
  const port = service.ports.PORT
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForGate(profile, workspace.id, 'web')
  const foreign = await startForeignListener(ade.ledger, port)
  await writeFile(gate, '')
  await expect.poll(async () => logText((await inspectService(profile, workspace.id, 'web')).logs)).toContain('bind failed: EADDRINUSE')
  await waitForReadiness(profile, workspace.id, 'web', 'port_conflict')
  await profile.call('listener.list', {})
  // A listener exists on the port, but not in the service's tree: the claim stays dispatched.
  const [claim] = await portClaims(profile, port)
  expect(claim).toMatchObject({ phase: 'dispatched', state: 'active' })
  expect(claim.listener_pid).toBeUndefined()

  await foreign.close()
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(await portClaims(profile, port)).toEqual([])
})

for (const mode of ['graceful', 'kill'] as const) {
  test(`a dispatched claim is kept as an unknown outcome, never bound or released, across a ${mode} daemon restart`, async ({ ade, profile, repo }) => {
    const { workspace } = await profile.call('workspace.open', { path: repo.path })
    const files = await writeServicePrograms(repo.path)
    const gate = join(ade.root, 'gate')
    const service = await configureService(profile, workspace.id, 'web', nodeService(files.server, { env: { E2E_GATE: gate } }))
    const port = service.ports.PORT
    await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
    await waitForGate(profile, workspace.id, 'web')
    const [before] = await portClaims(profile, port)
    expect(before).toMatchObject({ phase: 'dispatched', state: 'active' })

    await profile.restartDaemon(mode)
    // The new daemon cannot know whether the earlier incarnation's launch bound:
    // it keeps the claim as an unknown outcome, neither released nor assumed bound.
    const [after] = await portClaims(profile, port)
    expect(after).toMatchObject({ id: before.id, phase: 'dispatched', state: 'quarantined', reason: 'outcome_unknown',
      mine: false })
    expect(after.listener_pid).toBeUndefined()

    // The adopted run binds and serves; that alone does not promote the unknown claim.
    await writeFile(gate, '')
    await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
    expect((await httpGet(`http://127.0.0.1:${port}/`)).json).toMatchObject({ service: 'web' })
    await profile.call('listener.list', {})
    const [kept] = await portClaims(profile, port)
    expect(kept).toMatchObject({ id: before.id, phase: 'dispatched', state: 'quarantined' })
    expect(kept.listener_pid).toBeUndefined()

    // A verified stop of the adopted run settles it.
    await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
    expect(await portClaims(profile, port)).toEqual([])
  })
}
