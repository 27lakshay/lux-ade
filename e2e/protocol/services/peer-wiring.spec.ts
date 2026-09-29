// F086 peer wiring: a running service keeps the peer URLs it was given across
// a daemon handoff, and an IPv6-only peer is reached through a verified ::1
// URL. Ported from the legacy e2e/specs/service-peer-wiring spec.
import { expect, test, type ScratchProfile } from '../fixtures'

async function text(url: string): Promise<string> {
  try {
    return await (await fetch(url)).text()
  } catch {
    return ''
  }
}

function httpService(host: string, handler: string, extra: Record<string, unknown> = {}) {
  return {
    program: process.execPath,
    cwd: '.',
    env: {},
    ports: ['PORT'],
    args: ['-e', `require("http").createServer(${handler}).listen(Number(process.env.PORT),"${host}")`],
    ...extra,
  }
}

const relay = 'async(_,res)=>res.end(await (await fetch(process.env.API_URL)).text())'

async function configure(profile: ScratchProfile, workspace_id: string, name: string, config: unknown) {
  return (await profile.call('service.configure', { workspace_id, name, revision: 0, config } as never)).service
}

test('a daemon handoff retains the URLs given to a running peer-dependent service', async ({ ade, profile }) => {
  const workspace_id = (await profile.call('workspace.open', { path: ade.root })).workspace.id
  const api = await configure(profile, workspace_id, 'api', httpService('127.0.0.1', '(_,res)=>res.end("handoff-api")'))
  await configure(
    profile,
    workspace_id,
    'web',
    httpService('127.0.0.1', relay, { peers: { API_URL: { service: 'api', port_variable: 'PORT' } } }),
  )
  await profile.call('service.start', { workspace_id, name: 'api' })
  await expect.poll(() => text(`http://127.0.0.1:${api.ports.PORT}`)).toBe('handoff-api')
  const started = await profile.call('service.start', { workspace_id, name: 'web' })
  const transfer = started.service.terminal_owner?.transfer_id
  const expected = { API_URL: `http://127.0.0.1:${api.ports.PORT}` }
  const view = () => profile.call('service.inspect', { workspace_id, name: 'web', tail_bytes: 256 })
  expect((await view()).effective_peers).toEqual(expected)

  await profile.restartDaemon('graceful')
  expect(await view()).toMatchObject({
    execution_state: 'running',
    effective_peers: expected,
    current_peer_endpoints: expected,
  })
  const repeated = await profile.call('service.start', { workspace_id, name: 'web' })
  expect(repeated.service.terminal_owner?.transfer_id).toBe(transfer)
  expect(repeated.effective_peers).toEqual(expected)
  await profile.call('service.stop', { workspace_id, name: 'web' })
  await profile.call('service.stop', { workspace_id, name: 'api' })
})

test('an IPv6-only managed peer receives a verified loopback URL', async ({ profile }) => {
  const workspace_id = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace.id
  const api = await configure(profile, workspace_id, 'ipv6-api', httpService('::1', '(_,res)=>res.end("ipv6-peer")'))
  const web = await configure(
    profile,
    workspace_id,
    'ipv6-web',
    httpService('127.0.0.1', relay, { peers: { API_URL: { service: 'ipv6-api', port_variable: 'PORT' } } }),
  )
  await profile.call('service.start', { workspace_id, name: 'ipv6-api' })
  await expect.poll(() => text(`http://[::1]:${api.ports.PORT}/`)).toBe('ipv6-peer')
  const inventory = await profile.call('listener.list', {})
  expect(inventory.listeners.some((listener) => listener.port === api.ports.PORT && listener.family === 'ipv6')).toBe(
    true,
  )
  const started = await profile.call('service.start', { workspace_id, name: 'ipv6-web' })
  expect(started.effective_peers).toEqual({ API_URL: `http://[::1]:${api.ports.PORT}` })
  // The dependent service reaches its peer through the URL it was given.
  await expect.poll(() => text(`http://127.0.0.1:${web.ports.PORT}/`)).toBe('ipv6-peer')
  const observed = await profile.call('service.inspect', { workspace_id, name: 'ipv6-web', tail_bytes: 256 })
  expect(observed.current_peer_endpoints).toEqual(started.effective_peers)
  await profile.call('service.stop', { workspace_id, name: 'ipv6-web' })
  await profile.call('service.stop', { workspace_id, name: 'ipv6-api' })
})
