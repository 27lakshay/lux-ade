// F129: a remote service preview. A service the remote daemon runs on its
// own host is forwarded to this machine with `ssh -L`, pinned to that host's
// key, only when the user names that host and the URL is its own loopback
// address. The forward keeps its target: when the link drops it closes and is
// never reopened against another host or served locally. Device control on a
// remote host stays unsupported and is never redirected to this Mac.
import { expect, remoteCall, remoteClient, test } from '../fixtures/remote-hosts'
import { isRunning } from '../fixtures'
import { httpGet, nodeService, writeServicePrograms } from '../fixtures/services'
import { hostEntry, pairedLink, startedHost } from './steps'

test('a remote service is previewed through a pinned forward to its own host and never through another', async ({ remote }) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  const beta = await startedHost(remote, profile, 'beta')
  const alphaLink = await pairedLink(remote, alpha)
  const betaLink = await pairedLink(remote, beta)

  // A service runs on alpha under alpha's daemon.
  const repo = await alpha.host.repo('web')
  const { workspace } = await remoteCall(alphaLink, 'workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const configured = (await remoteCall(alphaLink, 'service.configure', { workspace_id: workspace.id, name: 'web',
    revision: 0, config: nodeService(files.server) })).service
  const port = configured.ports.PORT
  const started = await remoteCall(alphaLink, 'service.start', { workspace_id: workspace.id, name: 'web' })
  const servicePid = (started.metrics as { shell_pid: number }).shell_pid
  await expect.poll(async () => (await remoteCall(alphaLink, 'service.inspect', { workspace_id: workspace.id,
    name: 'web' })).readiness.state, { timeout: 20_000 }).toBe('tcp_listening')

  const alphaEntry = await hostEntry(profile, 'alpha')
  expect(alphaEntry.capabilities).toMatchObject({ previews: 'ssh_forward', devices: 'unsupported' })
  const url = `http://127.0.0.1:${port}/app`
  expect(alphaLink.previewCapability(alphaEntry, url)).toMatchObject({ transport: 'ssh_forward', available: true,
    remoteHost: '127.0.0.1', remotePort: port, host: { kind: 'remote', host_id: 'alpha' } })

  // The preview is served by alpha's service, over a forward to alpha pinned to alpha's key.
  const preview = await alphaLink.openPreview(alphaEntry, url)
  expect(preview).toMatchObject({ host: { kind: 'remote', host_id: 'alpha' }, remoteHost: '127.0.0.1',
    remotePort: port, url })
  expect(preview.localPort).not.toBe(port)
  expect(preview.localUrl).toBe(`http://127.0.0.1:${preview.localPort}/app`)
  const served = await httpGet(preview.localUrl)
  expect(served.status).toBe(200)
  expect(served.json).toMatchObject({ service: 'web', pid: servicePid, port, path: '/app' })
  const forwards = (await remote.calls()).filter((call) => call.forwarding?.some((spec) => spec.startsWith('127.0.0.1:')))
  expect(forwards).toHaveLength(1)
  expect(forwards[0].forwarding).toEqual([`127.0.0.1:${preview.localPort}:127.0.0.1:${port}`])
  expect(forwards[0].args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'HostKeyAlias=ade-remote-alpha',
    'ForwardAgent=no', 'ExitOnForwardFailure=yes', '--', 'alpha']))
  expect(forwards[0].args.at(-1)).toBe('alpha')
  const forwardPid = forwards[0].pid

  // Beta's transport cannot preview alpha's service, a URL naming another machine is not
  // forwarded, and neither starts anything.
  await expect(betaLink.openPreview(alphaEntry, url)).rejects.toMatchObject({ code: 'unavailable', delivery: 'not_sent' })
  await expect(betaLink.openPreview(alphaEntry, url)).rejects.toThrow(/reaches beta, not alpha/)
  await expect(alphaLink.openPreview(alphaEntry, 'http://example.com:8080/')).rejects.toThrow(/not alpha's own loopback/)
  const { deviceCapability } = await remoteClient()
  expect(deviceCapability(alphaEntry)).toMatchObject({ access: 'unsupported', available: false,
    host: { kind: 'remote', host_id: 'alpha' } })
  expect((await remote.calls()).filter((call) => call.forwarding?.some((spec) => spec.startsWith('127.0.0.1:'))))
    .toHaveLength(1)

  // Closing the preview ends its forward process and its port.
  preview.close()
  expect(await preview.closed).toContain('closed')
  await expect.poll(() => isRunning(forwardPid)).toBe(false)
  await expect(httpGet(preview.localUrl)).rejects.toThrow()
})

test('a preview whose link drops closes and stays closed, is refused while the host is unreachable or revoked, and reopens only on the same host', async ({ remote }) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  const link = await pairedLink(remote, alpha)
  const repo = await alpha.host.repo('web')
  const { workspace } = await remoteCall(link, 'workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const port = (await remoteCall(link, 'service.configure', { workspace_id: workspace.id, name: 'web', revision: 0,
    config: nodeService(files.server) })).service.ports.PORT
  await remoteCall(link, 'service.start', { workspace_id: workspace.id, name: 'web' })
  await expect.poll(async () => (await remoteCall(link, 'service.inspect', { workspace_id: workspace.id,
    name: 'web' })).readiness.state, { timeout: 20_000 }).toBe('tcp_listening')
  const entry = await hostEntry(profile, 'alpha')
  const url = `http://127.0.0.1:${port}/`
  const preview = await link.openPreview(entry, url)
  expect((await httpGet(preview.localUrl)).json).toMatchObject({ service: 'web' })

  // The link drops: the forward ends and the local URL stops answering. Nothing reopens it.
  await alpha.host.linkDown()
  expect(await preview.closed).toMatch(/alpha/)
  expect(preview.isOpen()).toBe(false)
  await expect(httpGet(preview.localUrl)).rejects.toThrow()
  await expect.poll(() => link.getState().phase).not.toBe('connected')
  await expect(link.openPreview(entry, url)).rejects.toMatchObject({ code: 'unavailable', delivery: 'not_sent' })
  const forwardsDuringLoss = (await remote.calls()).filter((call) =>
    call.forwarding?.some((spec) => spec.startsWith('127.0.0.1:'))).length
  expect(forwardsDuringLoss).toBe(1)

  // After the link returns, the user opens it again explicitly: same host, same service.
  await alpha.host.linkUp()
  await expect.poll(() => link.getState().phase, { timeout: 30_000 }).toBe('connected')
  const reopened = await link.openPreview(entry, url)
  expect(reopened.host).toEqual({ kind: 'remote', host_id: 'alpha' })
  expect((await httpGet(reopened.localUrl)).json).toMatchObject({ service: 'web', port })

  // Revoking the pairing refuses new previews: the host refuses the pairing, and this profile
  // no longer reports the host started. The open preview is closed by its owner.
  await profile.call('remote.host.revoke', { host_id: 'alpha', pairing_id: alpha.pairing.pairing_id }, { timeoutMs: 75_000 })
  await expect(link.request('catalog.get')).rejects.toMatchObject({ code: 'pairing_revoked' })
  const revokedEntry = await hostEntry(profile, 'alpha')
  expect(revokedEntry.readiness).not.toBe('started')
  await expect(link.openPreview(revokedEntry, url)).rejects.toMatchObject({ code: 'unavailable', delivery: 'not_sent' })
  reopened.close()
  await reopened.closed
})
