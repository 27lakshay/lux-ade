// F088 stable dev URLs over a whole lifecycle: slow and hostile clients, a
// burst of parallel assets, a foreign process that takes the service port, a
// WebSocket held open across a daemon handoff, a full runtime stop, a
// reviewed remap after the service is replaced, a retirement that fails and
// one that fences an idle connection, and route churn past the route limit. Ported
// from the legacy e2e/specs/service-proxy spec; proxy.spec.ts covers the
// individual steps.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ScratchProfile } from '../fixtures'

const run = promisify(execFile)

/** An HTTP echo server that also speaks minimal WebSocket and closes its listener on SIGUSR1. */
const script = [
  'const http=require("node:http"),crypto=require("node:crypto");',
  'const server=http.createServer((req,res)=>{let body="";req.on("data",x=>body+=x);req.on("end",()=>res.end(req.url+"|"+body))})',
  '.on("upgrade",(req,socket)=>{const accept=crypto.createHash("sha1").update(req.headers["sec-websocket-key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");',
  'socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: "+accept+"\\r\\n\\r\\n");',
  'let pending=Buffer.alloc(0);socket.on("data",chunk=>{pending=Buffer.concat([pending,chunk]);',
  'while(pending.length>=6){const len=pending[1]&127;if(len>125||pending.length<6+len)break;',
  'const mask=pending.subarray(2,6),data=Buffer.from(pending.subarray(6,6+len));',
  'for(let i=0;i<data.length;i++)data[i]^=mask[i%4];pending=pending.subarray(6+len);',
  'socket.write(Buffer.concat([Buffer.from([129,data.length]),data]))}})})',
  '.listen(Number(process.env.PORT),"127.0.0.1");process.on("SIGUSR1",()=>server.close());setInterval(()=>{},1000);',
].join('')

function webConfig(ports: string[] = ['PORT']) {
  return { program: process.execPath, args: ['-e', script], env: {}, cwd: '.', ports }
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const wsUrl = new URL(url)
  wsUrl.protocol = 'ws:'
  wsUrl.pathname = '/echo'
  const peer = new WebSocket(wsUrl)
  await new Promise<void>((done, fail) => {
    peer.addEventListener('open', () => done(), { once: true })
    peer.addEventListener('error', () => fail(new Error('WebSocket upgrade failed')), { once: true })
  })
  return peer
}

function echo(peer: WebSocket, message: string): Promise<string> {
  return new Promise<string>((done, fail) => {
    peer.addEventListener('message', (event) => done(String(event.data)), { once: true })
    peer.addEventListener('error', () => fail(new Error('WebSocket relay failed')), { once: true })
    peer.send(message)
  })
}

function wrongHostStatus(url: string): Promise<number> {
  return new Promise<number>((done, fail) => {
    const peer = createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) })
    peer.setTimeout(5_000, () => peer.destroy(new Error('Proxy response timed out')))
    peer.once('connect', () => peer.write('GET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n'))
    let response = ''
    peer.on('data', (chunk) => {
      response += chunk.toString()
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
      if (status) {
        peer.destroy()
        done(Number(status))
      }
    })
    peer.once('error', fail)
  })
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((done) => {
    const peer = createConnection({ host: '127.0.0.1', port })
    peer.once('connect', () => {
      peer.destroy()
      done(true)
    })
    peer.once('error', () => {
      peer.destroy()
      done(false)
    })
  })
}

/** A client that trickles one header byte every 750 ms; the proxy must answer it within its header budget. */
function slowHeader(url: string): Promise<{ status: number; elapsed: number }> {
  const started = performance.now()
  return new Promise((done, fail) => {
    const peer = createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) })
    const deadline = setTimeout(() => peer.destroy(new Error('Slow header was not bounded')), 8_000)
    const trickle = setInterval(() => peer.write('G'), 750)
    let response = ''
    peer.on('data', (chunk) => {
      response += chunk.toString()
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
      if (status) {
        clearTimeout(deadline)
        clearInterval(trickle)
        peer.destroy()
        done({ status: Number(status), elapsed: performance.now() - started })
      }
    })
    peer.once('error', (error) => {
      clearTimeout(deadline)
      clearInterval(trickle)
      fail(error)
    })
  })
}

async function status(url: string | URL): Promise<number> {
  return (await fetch(url)).status
}

/** Hand the runtime over and wait until the daemon has exited, leaving it stopped for assertions. */
async function handOver(profile: ScratchProfile): Promise<void> {
  await profile.rpc({
    op: 'runtime.prepare_restart',
    operation_id: `handover-${randomUUID()}`,
    boot_id: profile.hello.boot_id,
  })
  await expect.poll(() => profile.daemonRunning).toBe(false)
}

/** Whether the runtime holds an established connection from the client's local port. */
async function runtimeAccepted(profile: ScratchProfile, clientPort: number): Promise<boolean> {
  const { runtime_pid } = await profile.call('runtime.status', {})
  const { stdout } = await run('lsof', ['-a', '-n', '-P', '-p', String(runtime_pid), '-iTCP', '-Fn']).catch(() => ({
    stdout: '',
  }))
  return stdout.split('\n').some((line) => line.endsWith(`->127.0.0.1:${clientPort}`))
}

test('runtime-owned service URL preserves HTTP and WebSocket traffic across service and daemon restarts', async ({
  ade,
  profile,
}) => {
  test.setTimeout(150_000)
  const workspace_id = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace.id
  const ensure = () => profile.call('service.proxy.ensure', { workspace_id, name: 'web', port_variable: 'PORT' })
  const inspectRoute = () => profile.call('service.proxy.inspect', { workspace_id, name: 'web', port_variable: 'PORT' })
  await profile.call('service.configure', { workspace_id, name: 'web', revision: 0, config: webConfig() })
  const route = await ensure()
  const url = route.url!
  expect(route).toMatchObject({ scope: 'local_private', owner: 'runtime' })
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  expect(await status(url)).toBe(503)
  // Slow clients are refused within the header budget, in parallel.
  const stalled = await Promise.all(Array.from({ length: 4 }, () => slowHeader(url)))
  expect(stalled.map((result) => result.status)).toEqual([400, 400, 400, 400])
  expect(Math.max(...stalled.map((result) => result.elapsed))).toBeLessThan(7_000)

  await profile.call('service.start', { workspace_id, name: 'web' })
  await expect.poll(() => status(new URL('/ready', url))).toBe(200)
  const response = await fetch(new URL('/nested/path?x=1', url), { method: 'POST', body: 'body-bytes' })
  expect(await response.text()).toBe('/nested/path?x=1|body-bytes')
  const assetsStarted = performance.now()
  const assets = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      fetch(new URL(`/asset-${index}`, url)).then(async (reply) => ({
        status: reply.status,
        text: await reply.text(),
      })),
    ),
  )
  const assetsElapsed = Math.round(performance.now() - assetsStarted)
  expect(assets).toEqual(Array.from({ length: 100 }, (_, index) => ({ status: 200, text: `/asset-${index}|` })))
  expect(assetsElapsed).toBeLessThan(15_000)
  const initialWebSocket = await openWebSocket(url)
  expect(await echo(initialWebSocket, 'proxy-echo')).toBe('proxy-echo')
  initialWebSocket.close()
  expect(await wrongHostStatus(url)).toBe(400)
  expect((await fetch(url, { headers: { Origin: 'https://attacker.example' } })).status).toBe(400)

  // A foreign process that takes the service port is never forwarded to.
  const beforeTakeover = await profile.call('service.list', { workspace_id })
  const managedPort = beforeTakeover.services.find((service) => service.name === 'web')!.ports.PORT
  const managedPid = Number((beforeTakeover.states.web?.metrics as { shell_pid: number }).shell_pid)
  await fetch(url) // Warm the route immediately before replacing its listener.
  process.kill(managedPid, 'SIGUSR1')
  await expect.poll(async () => (await text(`http://127.0.0.1:${managedPort}/`)) === null).toBe(true)
  const attacker = spawn(
    process.execPath,
    [
      '-e',
      'require("node:http").createServer((_,res)=>res.end("attacker")).listen(Number(process.env.PORT),"127.0.0.1")',
    ],
    { env: { ...process.env, PORT: String(managedPort) }, stdio: 'ignore' },
  )
  await ade.ledger.own(attacker.pid!, 'foreign listener')
  try {
    await expect.poll(() => text(`http://127.0.0.1:${managedPort}/`)).toBe('attacker')
    expect((await profile.call('service.list', { workspace_id })).states).toHaveProperty('web.state', 'running')
    expect(await status(url)).toBe(503)
  } finally {
    attacker.kill()
    await new Promise((done) => (attacker.exitCode === null ? attacker.once('exit', done) : done(undefined)))
  }

  await profile.call('service.stop', { workspace_id, name: 'web' })
  await expect.poll(() => status(url)).toBe(503)
  await profile.call('service.start', { workspace_id, name: 'web' })
  await expect.poll(() => status(url)).toBe(200)
  expect((await ensure()).url).toBe(url)

  // A WebSocket stays open while the daemon hands the runtime over.
  const retainedWebSocket = await openWebSocket(url)
  expect(await echo(retainedWebSocket, 'before-handoff')).toBe('before-handoff')
  await handOver(profile)
  await expect.poll(() => status(url)).toBe(503)
  expect(await echo(retainedWebSocket, 'during-handoff')).toBe('during-handoff')
  await profile.restartDaemon()
  expect((await ensure()).url).toBe(url)
  await expect.poll(() => status(url)).toBe(200)
  expect(await echo(retainedWebSocket, 'after-handoff')).toBe('after-handoff')
  retainedWebSocket.close()

  // A full runtime stop keeps the stable URL for the next runtime.
  await profile.call('service.stop', { workspace_id, name: 'web' })
  await profile.stop()
  await profile.restartDaemon()
  expect((await ensure()).url).toBe(url)
  expect(await status(url)).toBe(503)

  // A replaced service is forwarded to only after a reviewed remap.
  const oldIdentity = (await profile.call('service.list', { workspace_id })).services.find(
    (service) => service.name === 'web',
  )!
  await profile.call('service.remove', { workspace_id, name: 'web', revision: oldIdentity.revision })
  const replacementDraft = (
    await profile.call('service.configure', { workspace_id, name: 'web', revision: 0, config: webConfig([]) })
  ).service
  expect(replacementDraft.identity).not.toBe(oldIdentity.identity)
  // Hold the old target port so the replacement gets another one.
  const holder = createServer()
  await new Promise<void>((done, fail) => {
    holder.once('error', fail)
    holder.listen(Number(route.target_port), '127.0.0.1', () => done())
  })
  const replacement = (
    await profile.call('service.configure', { workspace_id, name: 'web', revision: 1, config: webConfig() })
  ).service
  await new Promise<void>((done, fail) => holder.close((error) => (error ? fail(error) : done())))
  expect(replacement.identity).toBe(replacementDraft.identity)
  expect(replacement.ports.PORT).not.toBe(route.target_port)
  await profile.call('service.start', { workspace_id, name: 'web' })
  await expect.poll(() => status(url)).toBe(503)
  await expect(ensure()).rejects.toThrow(/Service target changed/)
  const remap = (expected: {
    expected_service_identity: string
    expected_target_port: number
    expected_route_identity: string
    expected_route_port: number
  }) => profile.call('service.proxy.remap', { workspace_id, name: 'web', port_variable: 'PORT', ...expected })
  await expect(
    remap({
      expected_service_identity: oldIdentity.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: oldIdentity.identity,
      expected_route_port: route.target_port,
    }),
  ).rejects.toThrow(/Service identity changed/)
  await expect(
    remap({
      expected_service_identity: replacement.identity,
      expected_target_port: route.target_port,
      expected_route_identity: oldIdentity.identity,
      expected_route_port: route.target_port,
    }),
  ).rejects.toThrow(/Service target port changed/)
  await expect(
    remap({
      expected_service_identity: replacement.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: replacement.identity,
      expected_route_port: route.target_port,
    }),
  ).rejects.toThrow(/route changed/)
  const pinned = await inspectRoute()
  expect(pinned.service_identity).toBe(oldIdentity.identity)
  await expect(
    remap({
      expected_service_identity: replacement.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: pinned.service_identity,
      expected_route_port: replacement.ports.PORT,
    }),
  ).rejects.toThrow(/route changed/)
  expect(
    (
      await remap({
        expected_service_identity: replacement.identity,
        expected_target_port: replacement.ports.PORT,
        expected_route_identity: pinned.service_identity,
        expected_route_port: pinned.target_port,
      })
    ).url,
  ).toBe(url)
  await expect.poll(() => status(url)).toBe(200)
  await profile.call('service.stop', { workspace_id, name: 'web' })

  await profile.call('service.start', { workspace_id, name: 'web' })
  await expect.poll(() => status(url)).toBe(200)
  const live = await openWebSocket(url)
  expect(await echo(live, 'before-retire')).toBe('before-retire')
  const beforeRetire = await inspectRoute()
  expect(beforeRetire.route_id).toMatch(/^route_/)
  const retire = {
    workspace_id,
    name: 'web',
    port_variable: 'PORT',
    expected_route_id: beforeRetire.route_id,
    expected_service_identity: beforeRetire.service_identity,
    expected_target_port: beforeRetire.target_port,
    expected_proxy_port: beforeRetire.port,
  }
  await expect(profile.call('service.proxy.retire', { ...retire, expected_proxy_port: 1 })).rejects.toThrow(
    /route changed/,
  )

  // A failed registry rename must leave the route and listener owned.
  const registry = join(profile.dataDirectory, 'service-proxies.json')
  const backup = `${registry}.backup`
  await rename(registry, backup)
  await mkdir(registry)
  try {
    await expect(profile.call('service.proxy.retire', retire)).rejects.toThrow(/retirement failed/)
    expect((await inspectRoute()).route_id).toBe(beforeRetire.route_id)
    expect(await status(url)).toBe(200)
  } finally {
    await rm(registry, { recursive: true, force: true })
    await rename(backup, registry)
  }

  // The runtime has accepted this TCP connection, but it has not sent
  // request headers. Retirement must fence a delayed request on that socket.
  const idle = createConnection({ host: '127.0.0.1', port: Number(beforeRetire.port) })
  await new Promise<void>((done, fail) => {
    idle.once('connect', () => done())
    idle.once('error', fail)
  })
  idle.setTimeout(5_000, () => idle.destroy(new Error('Idle proxy socket did not settle')))
  const idleReply = new Promise<string>((done, fail) => {
    let reply = ''
    idle.on('data', (chunk) => {
      reply += chunk.toString()
    })
    idle.once('close', () => done(reply))
    idle.once('error', fail)
  })
  await expect.poll(() => runtimeAccepted(profile, idle.localPort!)).toBe(true)
  expect((await profile.call('service.proxy.retire', retire)).type).toBe('service_proxy_retired')
  idle.write(`GET /late HTTP/1.1\r\nHost: 127.0.0.1:${beforeRetire.port}\r\n\r\n`)
  expect(await idleReply).toMatch(/^HTTP\/1\.1 503/)
  expect(await echo(live, 'after-retire')).toBe('after-retire')
  live.close()
  await expect.poll(() => canConnect(Number(beforeRetire.port))).toBe(false)
  await expect(inspectRoute()).rejects.toThrow(/does not exist/)
  const renewed = await ensure()
  expect(renewed.route_id).not.toBe(beforeRetire.route_id)
  expect(await status(renewed.url!)).toBe(200)
  await expect(profile.call('service.proxy.retire', retire)).rejects.toThrow(/route changed/)
  expect((await inspectRoute()).route_id).toBe(renewed.route_id)

  await profile.restartDaemon()
  expect((await inspectRoute()).route_id).toBe(renewed.route_id)
  const retireRoute = (target: typeof renewed) =>
    profile.call('service.proxy.retire', {
      workspace_id,
      name: 'web',
      port_variable: 'PORT',
      expected_route_id: target.route_id,
      expected_service_identity: target.service_identity,
      expected_target_port: target.target_port,
      expected_proxy_port: target.port,
    })
  await retireRoute(renewed)
  await expect.poll(() => canConnect(Number(renewed.port))).toBe(false)
  // More than the 256-route limit may be created over time when retired slots are released.
  for (let index = 0; index < 257; index++) await retireRoute(await ensure())
  await profile.call('service.stop', { workspace_id, name: 'web' })
  await profile.stop()
  await profile.restartDaemon()
  await expect(inspectRoute()).rejects.toThrow(/does not exist/)
})

async function text(url: string): Promise<string | null> {
  try {
    return await (await fetch(url)).text()
  } catch {
    return null
  }
}
