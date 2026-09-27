// F088 stable dev URLs: the runtime-owned proxy forwards HTTP and WebSocket
// traffic to the verified service run, survives daemon restarts, refuses a
// changed or unavailable target, and remaps or retires only on explicit,
// reviewed requests.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import {
  configureService,
  httpGet,
  nodeService,
  startForeignListener,
  waitForReadiness,
  websocketMessage,
  writeServicePrograms,
} from '../fixtures/services'

/** Send one raw HTTP/1.1 request and return the status line. */
function rawStatus(port: number, request: string): Promise<string> {
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    socket.setTimeout(10_000, () => {
      socket.destroy()
      rejectStatus(new Error('raw request timed out'))
    })
    socket.on('data', (chunk) => {
      received += chunk.toString()
    })
    socket.on('error', rejectStatus)
    socket.on('close', () => resolveStatus(received.split('\r\n')[0]))
    socket.write(request)
  })
}

test('a stable URL forwards HTTP and WebSocket traffic and is reused, not duplicated', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const service = await configureService(profile, workspace.id, 'web', nodeService(files.server))
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  expect(route).toMatchObject({
    scope: 'local_private',
    owner: 'runtime',
    service_identity: service.identity,
    target_port: service.ports.PORT,
  })
  expect(route.url).toBe(`http://127.0.0.1:${route.port}/`)
  expect(route.port).not.toBe(service.ports.PORT)

  const reply = await httpGet(`${route.url}through/proxy?x=1`)
  expect(reply.status).toBe(200)
  expect(reply.json).toMatchObject({ service: 'web', port: service.ports.PORT, path: '/through/proxy?x=1' })
  expect(await websocketMessage(route.url!)).toBe('ws:web')

  const again = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  expect(again).toEqual(route)
  expect(
    await profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
  ).toEqual(route)
  const cli = await profile.cli('service', 'url', workspace.id, 'web', 'PORT')
  expect(cli.json).toMatchObject({ type: 'service_proxy', route_id: route.route_id, url: route.url })

  // The proxy pins its explicit host: another Host header or a cross-origin request is refused.
  expect(await rawStatus(route.port, 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')).toMatch(
    /^HTTP\/1\.1 400/,
  )
  expect(
    await rawStatus(
      route.port,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${route.port}\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n`,
    ),
  ).toMatch(/^HTTP\/1\.1 400/)
  expect(
    await rawStatus(route.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${route.port}\r\nConnection: close\r\n\r\n`),
  ).toMatch(/^HTTP\/1\.1 200/)

  // An unknown port variable has no URL.
  await expect(
    profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'NOPE' }),
  ).rejects.toThrow(/Service has no configured port variable/)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a stable URL reports an unavailable target while stopped and serves the next run on the same address', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })

  // Never started: the route exists but refuses to forward.
  expect((await httpGet(route.url!)).status).toBe(503)

  const first = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  expect((await httpGet(route.url!)).json).toMatchObject({ pid: (first.metrics as { shell_pid: number }).shell_pid })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  const stopped = await httpGet(route.url!)
  expect(stopped.status).toBe(503)
  expect(stopped.text).toContain('Service unavailable')

  const second = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  expect(
    (await profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }))
      .url,
  ).toBe(route.url)
  expect((await httpGet(route.url!)).json).toMatchObject({ pid: (second.metrics as { shell_pid: number }).shell_pid })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a service that listens only on IPv6 loopback is ready, proxied and wired to its peers on ::1', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const api = await configureService(
    profile,
    workspace.id,
    'api',
    nodeService(files.server, { env: { E2E_HOST: '::1' } }),
  )
  await configureService(
    profile,
    workspace.id,
    'web',
    nodeService(files.server, {
      peers: { API_URL: { service: 'api', port_variable: 'PORT' } },
    }),
  )
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await profile.call('listener.list', {})).listeners.find((row) => row.port === api.ports.PORT)).toMatchObject({
    family: 'ipv6',
    ownership: 'managed_service',
    service_name: 'api',
  })

  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'api',
    port_variable: 'PORT',
  })
  expect((await httpGet(route.url!)).json).toMatchObject({ service: 'api', port: api.ports.PORT })
  expect(await websocketMessage(route.url!)).toBe('ws:api')

  const web = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  expect(web.effective_peers).toEqual({ API_URL: `http://[::1]:${api.ports.PORT}` })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
})

for (const mode of ['graceful', 'kill'] as const) {
  test(`a stable URL keeps its address and keeps forwarding across a ${mode} daemon restart`, async ({
    profile,
    repo,
  }) => {
    const { workspace } = await profile.call('workspace.open', { path: repo.path })
    const files = await writeServicePrograms(repo.path)
    await configureService(profile, workspace.id, 'web', nodeService(files.server))
    await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
    await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
    const route = await profile.call('service.proxy.ensure', {
      workspace_id: workspace.id,
      name: 'web',
      port_variable: 'PORT',
    })
    expect((await httpGet(route.url!)).status).toBe(200)

    await profile.restartDaemon(mode)

    expect(
      await profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
    ).toEqual(route)
    expect((await httpGet(route.url!)).json).toMatchObject({ service: 'web' })
    expect(await websocketMessage(route.url!)).toBe('ws:web')
    await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  })
}

test('a replaced service identity is never forwarded until an explicit, reviewed remap', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const original = await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })

  // Remove the service and create a new one with the same name: a new identity.
  await profile.call('service.remove', { workspace_id: workspace.id, name: 'web', revision: original.revision })
  const replacement = await configureService(profile, workspace.id, 'web', nodeService(files.server))
  expect(replacement.identity).not.toBe(original.identity)
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

  // The route still points at the old identity: it refuses instead of silently forwarding.
  expect((await httpGet(route.url!)).status).toBe(503)
  await expect(
    profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
  ).rejects.toThrow(/Service target changed; use service.proxy.remap/)

  const remap = {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
    expected_service_identity: replacement.identity,
    expected_target_port: replacement.ports.PORT,
    expected_route_identity: route.service_identity,
    expected_route_port: route.target_port,
  }
  // A remap reviewed against stale state is refused.
  await expect(
    profile.call('service.proxy.remap', { ...remap, expected_service_identity: original.identity }),
  ).rejects.toThrow(/Service identity changed; inspect it again/)
  await expect(
    profile.call('service.proxy.remap', { ...remap, expected_route_identity: 'service_stale' }),
  ).rejects.toThrow(/Stable service proxy route changed; inspect it again/)

  const remapped = await profile.call('service.proxy.remap', remap)
  expect(remapped).toMatchObject({
    url: route.url,
    port: route.port,
    route_id: route.route_id,
    service_identity: replacement.identity,
    target_port: replacement.ports.PORT,
  })
  expect((await httpGet(route.url!)).json).toMatchObject({ service: 'web' })
  // Repeating the reviewed remap now fails: its expectations no longer hold.
  await expect(profile.call('service.proxy.remap', remap)).rejects.toThrow(/Stable service proxy route changed/)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a stable URL is retired only when the reviewed route still matches', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  const retire = {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
    expected_route_id: route.route_id,
    expected_service_identity: route.service_identity,
    expected_target_port: route.target_port,
    expected_proxy_port: route.port,
  }
  await expect(profile.call('service.proxy.retire', { ...retire, expected_route_id: 'route_stale' })).rejects.toThrow()
  expect((await httpGet(route.url!)).status).toBe(200)

  const retired = await profile.call('service.proxy.retire', retire)
  expect(retired).toMatchObject({ type: 'service_proxy_retired', route_id: route.route_id, url: route.url })
  await expect(httpGet(route.url!)).rejects.toThrow()
  await expect(
    profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
  ).rejects.toThrow()
  // A repeated retire has nothing left to retire.
  await expect(profile.call('service.proxy.retire', retire)).rejects.toThrow()
  // Recovery reports a healthy registry with no blocked routes.
  expect(await profile.call('service.proxy.recovery.inspect', {})).toMatchObject({ status: 'healthy', routes: [] })

  // A new URL is a new route.
  const fresh = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  expect(fresh.route_id).not.toBe(route.route_id)
  expect((await httpGet(fresh.url!)).status).toBe(200)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a stable URL whose port is taken while its runtime is replaced is blocked, not remapped, until retried', async ({
  ade,
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  const retry = {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
    expected_route_id: route.route_id,
    expected_service_identity: route.service_identity,
    expected_target_port: route.target_port,
    expected_proxy_port: route.port,
  }

  // The runtime dies and a foreign process takes the stable URL's port before the next runtime starts.
  await profile.killRuntime()
  const foreign = await startForeignListener(ade.ledger, route.port)
  try {
    await profile.restartDaemon()
    const blocked = await profile.call('service.proxy.inspect', {
      workspace_id: workspace.id,
      name: 'web',
      port_variable: 'PORT',
    })
    expect(blocked).toMatchObject({
      url: null,
      port: route.port,
      route_id: route.route_id,
      availability: 'port_occupied',
    })
    const recovery = await profile.call('service.proxy.recovery.inspect', {})
    expect(recovery.status).toBe('degraded')
    expect(recovery.routes).toEqual([
      expect.objectContaining({
        route_id: route.route_id,
        port: route.port,
        availability: 'port_occupied',
        name: 'web',
        workspace_id: workspace.id,
      }),
    ])
    await expect(
      profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
    ).rejects.toThrow(/Stable service proxy port is unavailable; inspect recovery state/)
    await expect(profile.call('service.proxy.recovery.retry', retry)).rejects.toThrow()
  } finally {
    await foreign.close()
  }
  const retried = await profile.call('service.proxy.recovery.retry', retry)
  expect(retried).toMatchObject({ url: route.url, port: route.port, route_id: route.route_id })
  expect((await profile.call('service.proxy.recovery.inspect', {})).status).toBe('healthy')
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  expect((await httpGet(route.url!)).json).toMatchObject({ service: 'web' })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a corrupt stable URL registry is reported and reset only against the inspected digest', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  await profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' })

  await profile.killRuntime()
  const corrupt = '{"not": "a registry"'
  await writeFile(join(profile.dataDirectory, 'service-proxies.json'), corrupt)
  await profile.restartDaemon()

  const recovery = await profile.call('service.proxy.recovery.inspect', {})
  expect(recovery.status).toBe('corrupt')
  expect(recovery.registry_sha256).toBe(createHash('sha256').update(corrupt).digest('hex'))
  await expect(
    profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
  ).rejects.toThrow(/Stable proxy registry is corrupt; inspect recovery state/)
  await expect(
    profile.call('service.proxy.recovery.reset', { expected_registry_sha256: '0'.repeat(64) }),
  ).rejects.toThrow(/Stable proxy registry changed; inspect recovery state again/)

  const reset = await profile.call('service.proxy.recovery.reset', {
    expected_registry_sha256: recovery.registry_sha256!,
  })
  expect(reset).toMatchObject({ status: 'reset', previous_sha256: recovery.registry_sha256 })
  expect(await readFile(reset.archive, 'utf8')).toBe(corrupt)
  expect((await profile.call('service.proxy.recovery.inspect', {})).status).toBe('healthy')
  const fresh = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  expect(fresh.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
})
