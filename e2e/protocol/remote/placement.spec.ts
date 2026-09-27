// F126, F127 and F129: several execution hosts, explicit placement and the
// remote preview capability. Each host is labelled and reconnects on its own;
// new work names its host and a refusal never turns into local execution; a
// preview is forwarded only from the chosen host's own loopback address, and
// device control on a remote host is reported unsupported.
import { expect, remoteCall, remoteClient, test } from '../fixtures/remote-hosts'
import { addAndPair, operationId, startedHost, targetOf } from './steps'

const remoteHost = (hostId: string) => ({ kind: 'remote' as const, host_id: hostId })

test('several hosts are labelled apart, keep their own resources and reconnect independently', async ({ remote }) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  const beta = await startedHost(remote, profile, 'beta')

  const { hosts } = await profile.call('placement.hosts', {})
  expect(hosts.map((entry) => entry.host)).toEqual([{ kind: 'local' }, remoteHost('alpha'), remoteHost('beta')])
  const [, alphaEntry, betaEntry] = hosts
  expect(alphaEntry).toMatchObject({
    label: 'alpha',
    readiness: 'started',
    remote_socket: alpha.daemon.socket,
    remote_profile_id: alpha.remoteProfileId,
    capabilities: { previews: 'ssh_forward', devices: 'unsupported' },
  })
  expect(betaEntry).toMatchObject({
    label: 'beta',
    readiness: 'started',
    remote_socket: beta.daemon.socket,
    remote_profile_id: beta.remoteProfileId,
  })
  expect(alpha.daemon.socket).not.toBe(beta.daemon.socket)
  expect(alpha.daemon.boot_id).not.toBe(beta.daemon.boot_id)

  const alphaLink = await remote.transport(targetOf(alpha))
  const betaLink = await remote.transport(targetOf(beta))
  alphaLink.start()
  betaLink.start()
  const alphaState = await alphaLink.waitUntilConnected(15_000)
  const betaState = await betaLink.waitUntilConnected(15_000)
  expect(alphaState.key).not.toBe(betaState.key)
  expect(alphaState.pinned?.runtimeSocket).not.toBe(betaState.pinned?.runtimeSocket)

  const alphaWorkspace = (await remoteCall(alphaLink, 'workspace.open', { path: (await alpha.host.repo('a')).path }))
    .workspace
  const betaWorkspace = (await remoteCall(betaLink, 'workspace.open', { path: (await beta.host.repo('b')).path }))
    .workspace
  await profile.call('placement.record', {
    host: remoteHost('alpha'),
    resource: { kind: 'workspace', workspace_id: alphaWorkspace.id },
  })
  await profile.call('placement.record', {
    host: remoteHost('beta'),
    resource: { kind: 'workspace', workspace_id: betaWorkspace.id },
  })
  // A resource belongs to one host: recording it on another is refused.
  await expect(
    profile.call('placement.record', {
      host: remoteHost('beta'),
      resource: { kind: 'workspace', workspace_id: alphaWorkspace.id },
    }),
  ).rejects.toThrow(/alpha/)
  const alphaOnly = await profile.call('placement.list', { host_id: 'alpha' })
  expect(alphaOnly.placements.map((placement) => placement.resource)).toEqual([
    { kind: 'workspace', workspace_id: alphaWorkspace.id },
  ])
  // Each daemon holds only its own workspace.
  const alphaCatalog = (await remoteCall(alphaLink, 'catalog.get', {})).catalog.workspaces.map((entry) => entry.id)
  const betaCatalog = (await remoteCall(betaLink, 'catalog.get', {})).catalog.workspaces.map((entry) => entry.id)
  expect(alphaCatalog).toContain(alphaWorkspace.id)
  expect(alphaCatalog).not.toContain(betaWorkspace.id)
  expect(betaCatalog).toContain(betaWorkspace.id)
  expect(betaCatalog).not.toContain(alphaWorkspace.id)

  // Alpha loses its link; beta keeps working and alpha reconnects on its own to its own runtime.
  await alpha.host.linkDown()
  await expect.poll(() => alphaLink.getState().phase).not.toBe('connected')
  expect(betaLink.getState().phase).toBe('connected')
  expect((await remoteCall(betaLink, 'catalog.get', {})).boot_id).toBe(beta.daemon.boot_id)
  await expect(remoteCall(alphaLink, 'catalog.get', {})).rejects.toMatchObject({ delivery: 'not_sent' })
  await alpha.host.linkUp()
  await expect.poll(() => alphaLink.getState().phase, { timeout: 30_000 }).toBe('connected')
  expect(alphaLink.getState().current).toEqual(alphaState.current)
  expect(betaLink.getState().current).toEqual(betaState.current)
  expect((await remoteCall(alphaLink, 'catalog.get', {})).boot_id).toBe(alpha.daemon.boot_id)

  // The registry survives a local daemon restart with both hosts and their records.
  await profile.restartDaemon()
  const restored = (await profile.call('placement.hosts', {})).hosts
  expect(restored.map((entry) => entry.readiness)).toEqual(['ready', 'started', 'started'])
  expect(restored.slice(1).map((entry) => [entry.label, entry.remote_socket])).toEqual([
    ['alpha', alpha.daemon.socket],
    ['beta', beta.daemon.socket],
  ])
  expect(
    (await profile.call('placement.resolve', { resource: { kind: 'workspace', workspace_id: betaWorkspace.id } }))
      .placement.host,
  ).toEqual(remoteHost('beta'))
})

test('placement names its host explicitly, survives retries and is refused on an unavailable or incompatible host', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  const bare = await remote.host('bare', { artifacts: [] })
  await addAndPair(profile, bare, 'bare')
  const failed = await profile.call(
    'remote.host.start',
    { host_id: 'bare', operation_id: operationId('bare') },
    { timeoutMs: 120_000 },
  )
  expect(failed.outcome).toBe('failed')
  const { admitPlacement } = await remoteClient()

  // Local placement needs no transport.
  const local = await profile.call('placement.check', { host: { kind: 'local' }, resource: 'workspace' })
  expect(local).toMatchObject({ admitted: true, requires_remote_transport: false })
  expect(admitPlacement(local, null, null)).toMatchObject({ admitted: true, via: 'local_daemon' })

  // A remote placement is admitted by the daemon, then by a connected transport to that host.
  const check = await profile.call('placement.check', { host: remoteHost('alpha'), resource: 'workspace' })
  expect(check).toMatchObject({ admitted: true, requires_remote_transport: true, host: remoteHost('alpha') })
  const link = await remote.transport(targetOf(alpha))
  expect(link.admitPlacement(check)).toMatchObject({ admitted: false })
  link.start()
  await link.waitUntilConnected(15_000)
  expect(link.admitPlacement(check)).toMatchObject({
    admitted: true,
    via: 'remote_transport',
    host: remoteHost('alpha'),
  })
  const workspace = (await remoteCall(link, 'workspace.open', { path: (await alpha.host.repo('app')).path })).workspace
  const recorded = await profile.call('placement.record', {
    host: remoteHost('alpha'),
    resource: { kind: 'workspace', workspace_id: workspace.id },
  })

  // Retries keep the choice: the same check and record converge.
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      await profile.call('placement.check', {
        host: remoteHost('alpha'),
        resource: 'conversation',
        workspace_id: workspace.id,
      }),
    ).toMatchObject({ admitted: true, host: remoteHost('alpha') })
    const again = await profile.call('placement.record', {
      host: remoteHost('alpha'),
      resource: { kind: 'workspace', workspace_id: workspace.id },
    })
    expect(again.placement).toEqual(recorded.placement)
  }
  await profile.restartDaemon('kill')
  expect(
    (await profile.call('placement.resolve', { resource: { kind: 'workspace', workspace_id: workspace.id } }))
      .placement,
  ).toEqual(recorded.placement)

  // Unregistered, failed and incompatible placements are refused, naming the chosen host and nothing else.
  const ghost = await profile.cli('placement', 'check', 'ghost', 'workspace')
  expect(ghost.code).not.toBe(0)
  expect(ghost.json).toMatchObject({ code: 'not_applied' })
  expect(ghost.json?.message).toContain('remote host ghost is not a registered execution host. Nothing was placed.')
  const unavailable = await profile.call('placement.check', { host: remoteHost('bare'), resource: 'workspace' })
  expect(unavailable).toMatchObject({ admitted: false, host: remoteHost('bare') })
  expect(unavailable.reason).toContain('The last start failed')
  expect(unavailable.reason).toContain('Nothing was placed')
  expect(unavailable.reason).not.toMatch(/local|this Mac/i)
  const wrongHost = await profile.call('placement.check', {
    host: remoteHost('bare'),
    resource: 'conversation',
    workspace_id: workspace.id,
  })
  expect(wrongHost).toMatchObject({ admitted: false })
  expect(wrongHost.reason).toContain('The workspace runs on remote host alpha')
  const localInRemote = await profile.call('placement.check', {
    host: { kind: 'local' },
    resource: 'terminal',
    workspace_id: workspace.id,
  })
  expect(localInRemote).toMatchObject({ admitted: false })
  expect(localInRemote.reason).toContain('remote host alpha')
  await expect(
    profile.call('placement.record', {
      host: remoteHost('bare'),
      resource: { kind: 'conversation', workspace_id: workspace.id, conversation_id: 'conversation_x' },
    }),
  ).rejects.toThrow()

  // A link loss makes the host unusable for new work until it reconnects; nothing goes local.
  await alpha.host.linkDown()
  await expect.poll(() => link.getState().phase).not.toBe('connected')
  const during = link.admitPlacement(check)
  expect(during).toMatchObject({ admitted: false, host: remoteHost('alpha') })
  expect((during as { reason: string }).reason).toContain('Nothing was sent to another host')
  await alpha.host.linkUp()
  await expect.poll(() => link.getState().phase, { timeout: 30_000 }).toBe('connected')
  expect(link.admitPlacement(check)).toMatchObject({ admitted: true, via: 'remote_transport' })
})

test("the remote preview capability forwards only the chosen host's loopback service and reports device control unsupported", async ({
  remote,
}) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  await startedHost(remote, profile, 'beta')

  const local = await profile.cli('placement', 'preview', 'local', 'http://localhost:3000/')
  expect(local.code).toBe(0)
  expect(local.json).toMatchObject({
    preview: { host: { kind: 'local' }, transport: 'direct', available: true },
    devices: { host: { kind: 'local' }, access: 'local_host' },
  })

  const forwarded = await profile.cli(
    'placement',
    'preview',
    'alpha',
    'http://127.0.0.1:5173/app',
    '--timeout-ms',
    '15000',
  )
  expect(forwarded.code, forwarded.stderr).toBe(0)
  expect(forwarded.json).toMatchObject({
    preview: {
      host: remoteHost('alpha'),
      transport: 'ssh_forward',
      supported: true,
      available: true,
      remoteHost: '127.0.0.1',
      remotePort: 5173,
      reason: null,
    },
    devices: { host: remoteHost('alpha'), access: 'unsupported', available: false },
  })
  expect((forwarded.json?.devices as { reason: string }).reason).toContain(
    'nothing is redirected to a device on this Mac',
  )
  // The capability came from a forward to alpha's own daemon, not beta's and not a local one.
  const forwards = (await remote.calls()).filter((call) => call.forwarding)
  expect(forwards).toHaveLength(1)
  expect(forwards[0].args.at(-1)).toBe('alpha')
  expect(forwards[0].forwarding![0].endsWith(`:${alpha.daemon.socket}`)).toBe(true)

  // A URL naming another machine is not forwarded.
  const elsewhere = await profile.cli('placement', 'preview', 'alpha', 'http://example.com:8080/')
  expect(elsewhere.json).toMatchObject({ preview: { host: remoteHost('alpha'), supported: false, available: false } })
  expect((elsewhere.json?.preview as { reason: string }).reason).toContain("is not alpha's own loopback address")

  // An unreachable host reports the preview unavailable; it is never redirected to this Mac.
  await alpha.host.linkDown()
  const down = await profile.cli('placement', 'preview', 'alpha', 'http://127.0.0.1:5173/', '--timeout-ms', '3000')
  expect(down.code).toBe(0)
  expect(down.json).toMatchObject({
    preview: { host: remoteHost('alpha'), transport: 'ssh_forward', supported: true, available: false },
  })
  expect((down.json?.preview as { reason: string }).reason).toMatch(/alpha/)

  // A host that was never started offers no preview.
  const gamma = await remote.host('gamma')
  await addAndPair(profile, gamma, 'gamma')
  const notStarted = await profile.cli('placement', 'preview', 'gamma', 'http://127.0.0.1:5173/')
  expect(notStarted.json).toMatchObject({ preview: { host: remoteHost('gamma'), available: false } })
  expect((notStarted.json?.preview as { reason: string }).reason).toContain('has not been started')
  const unknownHost = await profile.cli('placement', 'preview', 'ghost', 'http://127.0.0.1:5173/')
  expect(unknownHost.code).not.toBe(0)
  expect(unknownHost.json).toMatchObject({ code: 'not_applied' })
})
