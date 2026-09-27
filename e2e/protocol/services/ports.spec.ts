// F087 port allocation across profiles: two profiles that share the host
// resources registry coordinate managed launches on the same assigned port.
// The second is refused while the first is launching or running, and admitted
// only after a verified stop released the claim.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, test } from '../fixtures'
import { configureService, httpGet, inspectService, logText, nodeService, rawReply, serviceNameForPort,
  serviceState, waitForReadiness, writeServicePrograms } from '../fixtures/services'

test('two profiles with the same assigned port launch one at a time', async ({ ade }) => {
  // Both daemons coordinate through one host registry, as managed profiles do.
  const shared = { ADE_HOST_RESOURCES_HOME: join(ade.root, 'host-resources') }
  const first = await ade.profile({ env: shared })
  const second = await ade.profile({ env: shared })
  const firstRepo = await ade.repo({ name: 'first' })
  const secondRepo = await ade.repo({ name: 'second' })
  const firstWorkspace = (await first.call('workspace.open', { path: firstRepo.path })).workspace
  const secondWorkspace = (await second.call('workspace.open', { path: secondRepo.path })).workspace
  const firstFiles = await writeServicePrograms(firstRepo.path)
  const secondFiles = await writeServicePrograms(secondRepo.path)

  // The second profile's catalogue chooses a port; pick a name the first profile's allocator also lands on.
  const theirs = await configureService(second, secondWorkspace.id, 'web', nodeService(secondFiles.server))
  const port = theirs.ports.PORT
  const gate = join(ade.root, 'first-gate')
  const name = serviceNameForPort(firstWorkspace.id, 'PORT', port)
  const mine = await configureService(first, firstWorkspace.id, name, nodeService(firstFiles.server, { env: { E2E_GATE: gate } }))
  expect(mine.ports.PORT).toBe(port)

  // The first profile launches; its service has not bound yet, so only the claim protects the port.
  await first.call('service.start', { workspace_id: firstWorkspace.id, name })
  await expect.poll(async () => logText((await inspectService(first, firstWorkspace.id, name)).logs)).toContain('waiting for gate')
  const claims = (await second.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port)
  expect(claims).toHaveLength(1)
  expect(claims[0]).toMatchObject({ mine: false, state: 'active', owner_profile: (await first.call('resources.inspect', {})).profile })

  await expect(second.call('service.start', { workspace_id: secondWorkspace.id, name: 'web' }))
    .rejects.toThrow(new RegExp(`tcp:${port} conflicts with the active exclusive use claim`))
  expect(await serviceState(second, secondWorkspace.id, 'web')).toBe('stopped')
  // The wire reply names the conflict and its recovery. The SDK, and the CLI through it, fold
  // codes they do not know into `daemon`, so only the message reaches their callers.
  expect(await rawReply(second.socket, { op: 'service.start', workspace_id: secondWorkspace.id, name: 'web' }))
    .toMatchObject({ type: 'error', code: 'host_resource_conflict', recovery: 'inspect_host_resources' })
  const cli = await second.cli('service', 'start', secondWorkspace.id, 'web')
  expect(cli.code).not.toBe(0)
  expect(String(cli.json?.message)).toContain(`tcp:${port} conflicts with the active exclusive use claim`)

  // Running and bound: still refused, now by the live listener as well.
  await writeFile(gate, '')
  await waitForReadiness(first, firstWorkspace.id, name, 'tcp_listening')
  expect((await first.call('resources.inspect', { resource: 'port' })).claims.find((claim) => claim.port === port))
    .toMatchObject({ phase: 'bound', mine: true })
  await expect(second.call('service.start', { workspace_id: secondWorkspace.id, name: 'web' })).rejects.toThrow()
  expect((await httpGet(`http://127.0.0.1:${port}/`)).json).toMatchObject({ service: name })

  // A verified stop releases the claim; the other profile is admitted.
  await first.call('service.stop', { workspace_id: firstWorkspace.id, name })
  expect((await first.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port)).toEqual([])
  const started = await second.call('service.start', { workspace_id: secondWorkspace.id, name: 'web' })
  await waitForReadiness(second, secondWorkspace.id, 'web', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${port}/`)).json).toMatchObject({ service: 'web',
    pid: (started.metrics as { shell_pid: number }).shell_pid })

  // Now the first profile is the one refused.
  await expect(first.call('service.start', { workspace_id: firstWorkspace.id, name })).rejects.toThrow()
  expect((await first.call('resources.inspect', { resource: 'port' })).claims.find((claim) => claim.port === port))
    .toMatchObject({ mine: false })
  await second.call('service.stop', { workspace_id: secondWorkspace.id, name: 'web' })
})

test('a profile that loses its daemon keeps its port claim until its own reconciliation proves the run gone', async ({ ade }) => {
  const shared = { ADE_HOST_RESOURCES_HOME: join(ade.root, 'host-resources') }
  const first = await ade.profile({ env: shared })
  const second = await ade.profile({ env: shared })
  const firstRepo = await ade.repo({ name: 'first' })
  const secondRepo = await ade.repo({ name: 'second' })
  const firstWorkspace = (await first.call('workspace.open', { path: firstRepo.path })).workspace
  const secondWorkspace = (await second.call('workspace.open', { path: secondRepo.path })).workspace
  const firstFiles = await writeServicePrograms(firstRepo.path)
  const secondFiles = await writeServicePrograms(secondRepo.path)
  const theirs = await configureService(second, secondWorkspace.id, 'web', nodeService(secondFiles.server))
  const port = theirs.ports.PORT
  const name = serviceNameForPort(firstWorkspace.id, 'PORT', port)
  await configureService(first, firstWorkspace.id, name, nodeService(firstFiles.server))
  const started = await first.call('service.start', { workspace_id: firstWorkspace.id, name })
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid
  await waitForReadiness(first, firstWorkspace.id, name, 'tcp_listening')

  // The first daemon dies; its runtime keeps the service running.
  await first.killDaemon()
  expect(await isRunning(shellPid)).toBe(true)
  const orphaned = (await second.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port)
  expect(orphaned).toHaveLength(1)
  expect(orphaned[0].owner_live).toBe(false)
  // The claim still conflicts: the dead owner's service still runs.
  await expect(second.call('service.start', { workspace_id: secondWorkspace.id, name: 'web' })).rejects.toThrow()

  // The first profile's next daemon adopts the runtime; its stop settles the claim.
  await first.restartDaemon()
  expect(await serviceState(first, firstWorkspace.id, name)).toBe('running')
  await first.call('service.stop', { workspace_id: firstWorkspace.id, name })
  expect(await isRunning(shellPid)).toBe(false)
  expect((await second.call('resources.inspect', { resource: 'port' })).claims.filter((claim) => claim.port === port)).toEqual([])
  await second.call('service.start', { workspace_id: secondWorkspace.id, name: 'web' })
  await waitForReadiness(second, secondWorkspace.id, 'web', 'tcp_listening')
  await second.call('service.stop', { workspace_id: secondWorkspace.id, name: 'web' })
})
