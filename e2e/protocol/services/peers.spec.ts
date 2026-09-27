// F089 peer-service environment wiring: declared dependencies resolve to the
// peer's verified loopback listener, the effective configuration is visible,
// and an unavailable or changed dependency is reported, never substituted.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import {
  configureService,
  httpGet,
  inspectService,
  nodeService,
  startForeignListener,
  waitForReadiness,
  writeServicePrograms,
} from '../fixtures/services'

test('a service receives its running peer endpoint and reports when the peer goes away', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const api = await configureService(profile, workspace.id, 'api', nodeService(files.server))
  const web = await configureService(
    profile,
    workspace.id,
    'web',
    nodeService(files.server, {
      env: { MODE: 'development' },
      peers: { API_URL: { service: 'api', port_variable: 'PORT' } },
    }),
  )
  expect(web.config.peers).toEqual({ API_URL: { service: 'api', port_variable: 'PORT' } })

  // The dependency is not running: the start is refused rather than wired to a guess.
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'web' })).rejects.toThrow(
    /Peer service api is stopped/,
  )
  const idle = await inspectService(profile, workspace.id, 'web')
  expect(idle.peer_error).toMatch(/Peer service api is stopped/)
  expect(idle.effective_peers).toEqual({})

  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  const apiUrl = `http://127.0.0.1:${api.ports.PORT}`
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  expect(started.effective_peers).toEqual({ API_URL: apiUrl })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')

  // The process saw exactly the resolved endpoint, and it reaches the peer.
  const seen = await httpGet(`http://127.0.0.1:${web.ports.PORT}/`)
  expect(seen.json).toMatchObject({ peers: { API_URL: apiUrl } })
  expect((await httpGet(`${apiUrl}/from-web`)).json).toMatchObject({ service: 'api' })

  const wired = await inspectService(profile, workspace.id, 'web')
  expect(wired).toMatchObject({
    effective_peers: { API_URL: apiUrl },
    current_peer_endpoints: { API_URL: apiUrl },
    peer_error: null,
  })
  // The effective, nonsecret configuration is visible with the run.
  expect(wired.service.config.env).toEqual({ MODE: 'development' })
  expect(wired.service.launch_peers).toEqual({ API_URL: apiUrl })

  // The peer stops: the dependent keeps its launch values and reports the dependency as unavailable.
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
  const orphaned = await inspectService(profile, workspace.id, 'web')
  expect(orphaned.effective_peers).toEqual({ API_URL: apiUrl })
  expect(orphaned.current_peer_endpoints).toEqual({})
  expect(orphaned.peer_error).toMatch(/Peer service api is stopped/)

  // The peer comes back on its stable port: the endpoint matches the launch value again.
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  await expect.poll(async () => (await inspectService(profile, workspace.id, 'web')).peer_error).toBeNull()

  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
})

test('peer declarations refuse cycles, unknown services and missing ports', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'api', nodeService(files.server))
  await configureService(
    profile,
    workspace.id,
    'web',
    nodeService(files.server, {
      peers: { API_URL: { service: 'api', port_variable: 'PORT' } },
    }),
  )

  // api -> web -> api is a cycle.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 1,
      config: nodeService(files.server, { peers: { WEB_URL: { service: 'web', port_variable: 'PORT' } } }),
    }),
  ).rejects.toThrow(/Service peer dependency cycle/)

  await configureService(
    profile,
    workspace.id,
    'ghost-user',
    nodeService(files.server, {
      peers: { GHOST_URL: { service: 'ghost', port_variable: 'PORT' } },
    }),
  )
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'ghost-user' })).rejects.toThrow(
    /Peer service ghost is unavailable/,
  )

  await configureService(
    profile,
    workspace.id,
    'admin',
    nodeService(files.server, {
      peers: { API_URL: { service: 'api', port_variable: 'ADMIN_PORT' } },
    }),
  )
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'admin' })).rejects.toThrow(
    /Peer service api has no ADMIN_PORT port/,
  )
  expect(
    (await profile.call('service.list', { workspace_id: workspace.id })).services.every(
      (service) => service.terminal_owner === null,
    ),
  ).toBe(true)
})

test('a peer whose port a foreign process holds is not wired', async ({ ade, profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  const gate = join(ade.root, 'api-gate')
  const api = await configureService(
    profile,
    workspace.id,
    'api',
    nodeService(files.server, { env: { E2E_GATE: gate } }),
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
  const foreign = await startForeignListener(ade.ledger, api.ports.PORT)
  try {
    await writeFile(gate, '')
    await waitForReadiness(profile, workspace.id, 'api', 'port_conflict')
    await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'web' })).rejects.toThrow(
      /Peer service api does not own a verified loopback listener on PORT/,
    )
  } finally {
    await foreign.close()
  }
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
})
