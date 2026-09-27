// Service faults: a crashed service process, an interrupted request whose
// outcome the client never saw, concurrent stops, and a listener that escaped
// the service's process tree.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { expect, isRunning, test } from '../fixtures'
import { configureService, httpGet, inspectService, nodeService, serviceState, waitForReadiness,
  writeServicePrograms } from '../fixtures/services'

/** Write one request line and close the connection without reading the reply. */
function sendAndHangUp(socket: string, request: Record<string, unknown>): Promise<void> {
  return new Promise((resolveSent, rejectSent) => {
    const peer = createConnection(socket)
    peer.once('error', rejectSent)
    peer.once('connect', () => peer.end(`${JSON.stringify(request)}\n`, () => { peer.destroy(); resolveSent() }))
  })
}

test('a service process that crashes is reported exited and is restarted only after an explicit stop', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

  process.kill(shellPid, 'SIGKILL')
  await expect.poll(() => serviceState(profile, workspace.id, 'web')).toBe('exited')
  const inspection = await inspectService(profile, workspace.id, 'web')
  expect(inspection.readiness.state).toBe('exited')
  // The crashed run still holds its reservation: a start does not silently replace it.
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'web' }))
    .rejects.toThrow(/Service exited; stop the prior run before restarting/)
  expect((await profile.call('resources.inspect', { resource: 'port' })).claims
    .filter((claim) => claim.port === service.ports.PORT)).toHaveLength(1)

  const stopped = await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(stopped.service.terminal_owner).toBeNull()
  expect((await profile.call('resources.inspect', { resource: 'port' })).claims
    .filter((claim) => claim.port === service.ports.PORT)).toEqual([])
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a start or stop whose reply was lost converges when the client retries', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))

  // The client sends start and disconnects: it cannot know whether the run launched.
  await sendAndHangUp(profile.socket, { op: 'service.start', operation_id: 'lost-start', workspace_id: workspace.id,
    name: 'web' })
  await expect.poll(() => serviceState(profile, workspace.id, 'web')).toBe('running')
  const owner = (await profile.call('service.list', { workspace_id: workspace.id })).services[0].terminal_owner
  // Retrying returns the run the lost request launched instead of a second one.
  const retried = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  expect(retried.service.terminal_owner).toEqual(owner)
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

  await sendAndHangUp(profile.socket, { op: 'service.stop', operation_id: 'lost-stop', workspace_id: workspace.id,
    name: 'web' })
  await expect.poll(() => serviceState(profile, workspace.id, 'web')).toBe('stopped')
  const stopped = await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  expect(stopped.service.terminal_owner).toBeNull()
})

test('a service that ignores SIGTERM is escalated and its stop is still verified', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'stubborn', nodeService(files.server,
    { env: { E2E_IGNORE_TERM: '1', E2E_IGNORE_HUP: '1' } }))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'stubborn' })
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  await waitForReadiness(profile, workspace.id, 'stubborn', 'tcp_listening')

  const stopped = await profile.call('service.stop', { workspace_id: workspace.id, name: 'stubborn' })
  expect(stopped.service.terminal_owner).toBeNull()
  expect(await isRunning(shellPid)).toBe(false)
  expect((await profile.call('resources.inspect', { resource: 'port' })).claims
    .filter((claim) => claim.port === service.ports.PORT)).toEqual([])
})

test('concurrent stops settle once and both callers see a stopped service', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

  const results = await Promise.allSettled([
    profile.call('service.stop', { workspace_id: workspace.id, name: 'web' }),
    profile.call('service.stop', { workspace_id: workspace.id, name: 'web' }),
  ])
  expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
  for (const result of results) {
    if (result.status === 'rejected') expect(String(result.reason)).toMatch(/Service stop is already in progress/)
    else expect(result.value.service.terminal_owner).toBeNull()
  }
  expect(await isRunning((started.metrics as { shell_pid: number }).shell_pid)).toBe(false)
  expect(await serviceState(profile, workspace.id, 'web')).toBe('stopped')
})

test('a listener that escaped the service tree keeps the port claim quarantined after stop', async ({ ade, profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  // A launcher that double-forks the server into its own session and stays alive itself.
  const launcher = join(repo.path, 'e2e-service', 'escape.mjs')
  await writeFile(launcher, `import { spawn } from 'node:child_process'
const middle = spawn(process.execPath, ['-e', ${JSON.stringify(
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(files.server)}], { detached: true, stdio: 'ignore' }).unref()`)}],
  { detached: true, stdio: 'ignore' })
middle.on('exit', () => console.log('escaped'))
setInterval(() => {}, 1 << 30)
`)
  const service = await configureService(profile, workspace.id, 'escape', nodeService(launcher))
  const port = service.ports.PORT
  await profile.call('service.start', { workspace_id: workspace.id, name: 'escape' })
  // The escaped server answers on the assigned port, but it is not in the run's tree.
  await expect.poll(async () => (await httpGet(`http://127.0.0.1:${port}/`).catch(() => null))?.status ?? 0).toBe(200)
  const escapedPid = Number((await httpGet(`http://127.0.0.1:${port}/`)).json?.pid)
  await ade.ledger.own(escapedPid, 'escaped service listener')
  try {
    await waitForReadiness(profile, workspace.id, 'escape', 'port_conflict')
    await profile.call('service.stop', { workspace_id: workspace.id, name: 'escape' }).catch((error: unknown) => {
      // Stop may also refuse because the tree was not confirmed stopped; either way nothing is released.
      expect(String(error)).toMatch(/not confirmed stopped|has not exited/)
    })
    expect(await isRunning(escapedPid)).toBe(true)
    const claims = (await profile.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port)
    expect(claims).toHaveLength(1)
    expect(claims[0].state).toBe('quarantined')
  } finally {
    try { process.kill(escapedPid, 'SIGKILL') } catch { /* Already gone. */ }
    await expect.poll(() => isRunning(escapedPid)).toBe(false)
  }
  if ((await serviceState(profile, workspace.id, 'escape')) !== 'stopped') {
    await profile.call('service.stop', { workspace_id: workspace.id, name: 'escape' })
  }
})

// Architecture section 4: effect commands carry a caller operation ID, a
// daemon-computed payload fingerprint, a receipt and reconciliation.
// GAP: service.start and service.stop take no operation_id and return no
// receipt (phase1-services evidence, "Effect commands have no operation_id or
// receipt"). A retry converges on service state instead (see the lost-reply
// test above), but a replay cannot be matched to its original request.
test.fixme('service.start replays by operation ID and returns its receipt', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const request = { op: 'service.start', workspace_id: workspace.id, name: 'web', operation_id: 'op-service-start-1' }
  const first = await profile.rpc(request)
  const replay = await profile.rpc(request)
  expect(first.receipt).toBeTruthy()
  expect(replay.receipt).toEqual(first.receipt)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})
