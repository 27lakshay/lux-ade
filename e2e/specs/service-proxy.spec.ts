import { expect, test, _electron as electron } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { rpc } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

test('runtime-owned service URL preserves HTTP and WebSocket traffic across service and daemon restarts', async () => {
  test.setTimeout(150_000)
  const root = await mkdtemp(join(tmpdir(), 'ade-proxy-e2e-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  await mkdir(dataDirectory, { mode: 0o700 })
  let child: ChildProcess | undefined
  let attacker: ChildProcess | undefined
  let hello: Record<string, unknown> | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: { ...process.env,
      ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh' },
    stdio: ['ignore', 'ignore', 'pipe'] })
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* Wait for daemon startup. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  const stopDaemon = async (): Promise<void> => {
    const running = child
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => running?.exitCode).not.toBeNull()
  }
  const openWebSocket = async (url: string): Promise<WebSocket> => {
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
  const echo = async (peer: WebSocket, message: string): Promise<string> => {
    return await new Promise<string>((done, fail) => {
      peer.addEventListener('message', (event) => done(String(event.data)), { once: true })
      peer.addEventListener('error', () => fail(new Error('WebSocket relay failed')), { once: true })
      peer.send(message)
    })
  }
  const wrongHostStatus = async (url: string): Promise<number> => {
    const port = Number(new URL(url).port)
    return await new Promise<number>((done, fail) => {
      const peer = createConnection({ host: '127.0.0.1', port })
      peer.setTimeout(5_000, () => peer.destroy(new Error('Proxy response timed out')))
      peer.once('connect', () => peer.write('GET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n'))
      let response = ''
      peer.on('data', (chunk) => {
        response += chunk.toString()
        const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
        if (status) { peer.destroy(); done(Number(status)) }
      })
      peer.once('error', fail)
    })
  }
  const canConnect = async (port: number): Promise<boolean> => await new Promise((done) => {
    const peer = createConnection({ host: '127.0.0.1', port })
    peer.once('connect', () => { peer.destroy(); done(true) })
    peer.once('error', () => { peer.destroy(); done(false) })
  })
  const slowHeader = async (url: string): Promise<{ status: number; elapsed: number }> => {
    const started = performance.now()
    return await new Promise((done, fail) => {
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
  try {
    await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
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
    await rpc(socket, { op: 'service.configure', workspace_id: workspace.id, name: 'web', revision: 0,
      config: { program: process.execPath, args: ['-e', script], env: {}, cwd: '.', ports: ['PORT'] } })
    const route = await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })
    const url = route.url as string
    expect(route).toMatchObject({ scope: 'local_private', owner: 'runtime' })
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect((await fetch(url)).status).toBe(503)
    const stalled = await Promise.all(Array.from({ length: 4 }, () => slowHeader(url)))
    expect(stalled.map((result) => result.status)).toEqual([400, 400, 400, 400])
    expect(Math.max(...stalled.map((result) => result.elapsed))).toBeLessThan(7_000)

    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(new URL('/ready', url))).status).toBe(200)
    const response = await fetch(new URL('/nested/path?x=1', url), { method: 'POST', body: 'body-bytes' })
    expect(await response.text()).toBe('/nested/path?x=1|body-bytes')
    const assetsStarted = performance.now()
    const assets = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      fetch(new URL(`/asset-${index}`, url)).then(async (reply) => ({ status: reply.status,
        text: await reply.text() }))))
    const assetsElapsed = Math.round(performance.now() - assetsStarted)
    console.log(`F088 100 parallel HTTP assets via proxy: ${assetsElapsed} ms; ` +
      `${assets.filter((asset) => asset.status !== 200).length} unavailable`)
    expect(assets).toEqual(Array.from({ length: 100 }, (_, index) => ({ status: 200,
      text: `/asset-${index}|` })))
    expect(assetsElapsed).toBeLessThan(15_000)
    const initialWebSocket = await openWebSocket(url)
    expect(await echo(initialWebSocket, 'proxy-echo')).toBe('proxy-echo')
    initialWebSocket.close()
    expect(await wrongHostStatus(url)).toBe(400)
    expect((await fetch(url, { headers: { Origin: 'https://attacker.example' } })).status).toBe(400)

    const beforeTakeover = await rpc(socket, { op: 'service.list', workspace_id: workspace.id })
    const managedPort = (beforeTakeover.services as { name: string; ports: { PORT: number } }[])
      .find((service) => service.name === 'web')!.ports.PORT
    const managedPid = Number((beforeTakeover.states as { web: { metrics: { shell_pid: number } } })
      .web.metrics.shell_pid)
    await fetch(url) // Warm the route immediately before replacing its listener.
    process.kill(managedPid, 'SIGUSR1')
    await expect.poll(async () => {
      try { await fetch(`http://127.0.0.1:${managedPort}/`); return false }
      catch { return true }
    }).toBe(true)
    attacker = spawn(process.execPath, ['-e',
      'require("node:http").createServer((_,res)=>res.end("attacker")).listen(Number(process.env.PORT),"127.0.0.1")'],
    { env: { ...process.env, PORT: String(managedPort) }, stdio: 'ignore' })
    await expect.poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${managedPort}/`)).text() }
      catch { return '' }
    }).toBe('attacker')
    expect((await rpc(socket, { op: 'service.list', workspace_id: workspace.id })).states)
      .toHaveProperty('web.state', 'running')
    expect((await fetch(url)).status).toBe(503)
    attacker.kill()
    await new Promise((done) => attacker?.once('exit', done))
    attacker = undefined

    await rpc(socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(503)
    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(200)
    expect((await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).url).toBe(url)

    const retainedWebSocket = await openWebSocket(url)
    expect(await echo(retainedWebSocket, 'before-handoff')).toBe('before-handoff')
    const runtimeSocket = hello?.runtime_socket
    const runtimeInstance = hello?.runtime_instance
    await stopDaemon()
    await expect.poll(async () => (await fetch(url)).status).toBe(503)
    expect(await echo(retainedWebSocket, 'during-handoff')).toBe('during-handoff')
    await launch()
    expect((await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).url).toBe(url)
    await expect.poll(async () => (await fetch(url)).status).toBe(200)
    expect(await echo(retainedWebSocket, 'after-handoff')).toBe('after-handoff')
    retainedWebSocket.close()

    await rpc(socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    await stopDaemon()
    if (typeof runtimeSocket === 'string') {
      await rpc(runtimeSocket, { op: 'runtime.stop', instance_id: runtimeInstance, stop_active: true })
    }
    await launch()
    expect((await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).url).toBe(url)
    expect((await fetch(url)).status).toBe(503)

    const oldService = (await rpc(socket, { op: 'service.list', workspace_id: workspace.id }))
      .services as { name: string; identity: string; revision: number }[]
    const oldIdentity = oldService.find((service) => service.name === 'web')!
    await rpc(socket, { op: 'service.remove', workspace_id: workspace.id,
      name: 'web', revision: oldIdentity.revision })
    const replacementDraft = (await rpc(socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 0,
      config: { program: process.execPath, args: ['-e', script], env: {}, cwd: '.', ports: [] } }))
      .service as { identity: string }
    expect(replacementDraft.identity).not.toBe(oldIdentity.identity)
    const holder = createServer()
    await new Promise<void>((done, fail) => {
      holder.once('error', fail)
      holder.listen(Number(route.target_port), '127.0.0.1', () => done())
    })
    const replacement = (await rpc(socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 1,
      config: { program: process.execPath, args: ['-e', script], env: {}, cwd: '.', ports: ['PORT'] } }))
      .service as { identity: string; ports: { PORT: number } }
    await new Promise<void>((done, fail) => holder.close((error) => error ? fail(error) : done()))
    expect(replacement.identity).toBe(replacementDraft.identity)
    expect(replacement.ports.PORT).not.toBe(route.target_port)
    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(503)
    await expect(rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).rejects.toThrow(/Service target changed/)
    await expect(rpc(socket, { op: 'service.proxy.remap', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT', expected_service_identity: oldIdentity.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: oldIdentity.identity,
      expected_route_port: route.target_port })).rejects.toThrow(/Service identity changed/)
    await expect(rpc(socket, { op: 'service.proxy.remap', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT', expected_service_identity: replacement.identity,
      expected_target_port: route.target_port,
      expected_route_identity: oldIdentity.identity,
      expected_route_port: route.target_port })).rejects.toThrow(/Service target port changed/)
    await expect(rpc(socket, { op: 'service.proxy.remap', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT', expected_service_identity: replacement.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: replacement.identity,
      expected_route_port: route.target_port })).rejects.toThrow(/route changed/)
    const pinned = await rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })
    expect(pinned.service_identity).toBe(oldIdentity.identity)
    await expect(rpc(socket, { op: 'service.proxy.remap', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT', expected_service_identity: replacement.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: pinned.service_identity,
      expected_route_port: replacement.ports.PORT })).rejects.toThrow(/route changed/)
    expect((await rpc(socket, { op: 'service.proxy.remap', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT', expected_service_identity: replacement.identity,
      expected_target_port: replacement.ports.PORT,
      expected_route_identity: pinned.service_identity,
      expected_route_port: pinned.target_port })).url).toBe(url)
    await expect.poll(async () => (await fetch(url)).status).toBe(200)
    await rpc(socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })

    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await fetch(url)).status).toBe(200)
    const live = await openWebSocket(url)
    expect(await echo(live, 'before-retire')).toBe('before-retire')
    const beforeRetire = await rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })
    expect(beforeRetire.route_id).toMatch(/^route_/)
    const retire = { op: 'service.proxy.retire', workspace_id: workspace.id, name: 'web',
      port_variable: 'PORT', expected_route_id: beforeRetire.route_id,
      expected_service_identity: beforeRetire.service_identity,
      expected_target_port: beforeRetire.target_port, expected_proxy_port: beforeRetire.port }
    await expect(rpc(socket, { ...retire, expected_proxy_port: 1 })).rejects.toThrow(/route changed/)

    // A failed registry rename must leave the route and listener owned.
    const registry = join(dataDirectory, 'service-proxies.json')
    const backup = `${registry}.backup`
    await rename(registry, backup)
    await mkdir(registry)
    try {
      await expect(rpc(socket, retire)).rejects.toThrow(/retirement failed/)
      expect((await rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
        name: 'web', port_variable: 'PORT' })).route_id).toBe(beforeRetire.route_id)
      expect((await fetch(url)).status).toBe(200)
    } finally {
      await rm(registry, { recursive: true, force: true })
      await rename(backup, registry)
    }

    // The runtime already accepted this TCP connection, but it has not sent
    // request headers. Retirement must fence a delayed request on that socket.
    const idle = createConnection({ host: '127.0.0.1', port: Number(beforeRetire.port) })
    await new Promise<void>((done, fail) => {
      idle.once('connect', () => done())
      idle.once('error', fail)
    })
    idle.setTimeout(5_000, () => idle.destroy(new Error('Idle proxy socket did not settle')))
    await delay(100)
    const idleReply = new Promise<string>((done, fail) => {
      let reply = ''
      idle.on('data', (chunk) => { reply += chunk.toString() })
      idle.once('close', () => done(reply))
      idle.once('error', fail)
    })
    expect((await rpc(socket, retire)).type).toBe('service_proxy_retired')
    idle.write(`GET /late HTTP/1.1\r\nHost: 127.0.0.1:${beforeRetire.port}\r\n\r\n`)
    expect(await idleReply).toMatch(/^HTTP\/1\.1 503/)
    expect(await echo(live, 'after-retire')).toBe('after-retire')
    live.close()
    await expect.poll(() => canConnect(Number(beforeRetire.port))).toBe(false)
    await expect(rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).rejects.toThrow(/does not exist/)
    const renewed = await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })
    expect(renewed.route_id).not.toBe(beforeRetire.route_id)
    expect((await fetch(renewed.url as string)).status).toBe(200)
    await expect(rpc(socket, retire)).rejects.toThrow(/route changed/)
    expect((await rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).route_id).toBe(renewed.route_id)

    await stopDaemon()
    await launch()
    expect((await rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).route_id).toBe(renewed.route_id)
    await rpc(socket, { op: 'service.proxy.retire', workspace_id: workspace.id, name: 'web',
      port_variable: 'PORT', expected_route_id: renewed.route_id,
      expected_service_identity: renewed.service_identity,
      expected_target_port: renewed.target_port, expected_proxy_port: renewed.port })
    await expect.poll(() => canConnect(Number(renewed.port))).toBe(false)
    // More than the 256-route limit may be created over time when retired slots are released.
    for (let index = 0; index < 257; index++) {
      const fresh = await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
        name: 'web', port_variable: 'PORT' })
      await rpc(socket, { op: 'service.proxy.retire', workspace_id: workspace.id, name: 'web',
        port_variable: 'PORT', expected_route_id: fresh.route_id,
        expected_service_identity: fresh.service_identity,
        expected_target_port: fresh.target_port, expected_proxy_port: fresh.port })
    }
    await stopDaemon()
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true })
    }
    await launch()
    await expect(rpc(socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'web', port_variable: 'PORT' })).rejects.toThrow(/does not exist/)
  } finally {
    if (attacker && attacker.exitCode === null) attacker.kill()
    if (attacker && attacker.exitCode === null) await new Promise((done) => attacker?.once('exit', done))
    if (child && child.exitCode === null && hello) {
      await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id }).catch(() => undefined)
    }
    if (child && child.exitCode === null) child.kill()
    if (child && child.exitCode === null) await new Promise((done) => child?.once('exit', done))
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true }).catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('a v9 profile backfills distinct durable service identities before assigning stable URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-proxy-upgrade-e2e-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  await mkdir(dataDirectory, { mode: 0o700 })
  let child: ChildProcess | undefined
  let hello: Record<string, unknown> | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: { ...process.env,
      ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh' },
    stdio: ['ignore', 'ignore', 'pipe'] })
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* Wait for the profile daemon. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  const stop = async (): Promise<void> => {
    const running = child
    const runtimePid = hello?.runtime_pid
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => running?.exitCode).not.toBeNull()
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true })
    }
    // runtime.stop acknowledges the request before its listener threads exit.
    // Wait for the exact detached runtime to release its saved proxy ports.
    if (typeof runtimePid === 'number') {
      await expect.poll(() => {
        try { process.kill(runtimePid, 0); return true } catch { return false }
      }).toBe(false)
    }
  }
  try {
    await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    for (const name of ['first', 'second']) {
      await rpc(socket, { op: 'service.configure', workspace_id: workspace.id, name, revision: 0,
        config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
          env: {}, cwd: '.', ports: ['PORT'] } })
    }
    await stop()
    const database = join(dataDirectory, 'sessions.sqlite')
    await execFileAsync('python3', ['-c', `import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 rows=db.execute('SELECT workspace_id,name,data FROM services').fetchall()
 for workspace,name,data in rows:
  service=json.loads(data)
  service.pop('identity',None)
  db.execute('UPDATE services SET data=? WHERE workspace_id=? AND name=?',(json.dumps(service),workspace,name))
 db.execute('DELETE FROM schema_migrations WHERE version=10')
 db.execute('PRAGMA user_version=9')`, database])

    await launch()
    const migrated = (await rpc(socket, { op: 'service.list', workspace_id: workspace.id }))
      .services as { name: string; identity: string; revision: number }[]
    expect(migrated).toHaveLength(2)
    expect(migrated.every((service) => service.identity.startsWith('service_'))).toBe(true)
    expect(new Set(migrated.map((service) => service.identity)).size).toBe(2)
    const firstIdentity = migrated.find((service) => service.name === 'first')!.identity
    const route = await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'first', port_variable: 'PORT' })
    expect(route.service_identity).toBe(firstIdentity)
    const edited = (await rpc(socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'first', revision: 1, config: {
        program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
        env: { FLAG: '1' }, cwd: '.', ports: ['PORT'],
      } })).service as { identity: string }
    expect(edited.identity).toBe(firstIdentity)
    await stop()
    const proxyRegistry = join(dataDirectory, 'service-proxies.json')
    const legacyRoutes = JSON.parse(await readFile(proxyRegistry, 'utf8')) as Record<string, unknown>[]
    for (const legacyRoute of legacyRoutes) delete legacyRoute.route_id
    await writeFile(proxyRegistry, JSON.stringify(legacyRoutes))
    await launch()
    const afterRestart = (await rpc(socket, { op: 'service.list', workspace_id: workspace.id }))
      .services as { name: string; identity: string }[]
    expect(afterRestart.find((service) => service.name === 'first')?.identity).toBe(firstIdentity)
    const restored = await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'first', port_variable: 'PORT' })
    expect(restored.url).toBe(route.url)
    expect(restored.route_id).toMatch(/^route_/)
    const upgradedRoutes = JSON.parse(await readFile(proxyRegistry, 'utf8')) as { route_id: string }[]
    expect(upgradedRoutes[0]?.route_id).toBe(restored.route_id)
    const { stdout } = await execFileAsync('python3', ['-c',
      'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("PRAGMA user_version").fetchone()[0])', database])
    expect(stdout.trim()).toBe('10')
  } finally {
    if (child && child.exitCode === null && hello) {
      await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id }).catch(() => undefined)
    }
    if (child && child.exitCode === null) child.kill()
    if (child && child.exitCode === null) await new Promise((done) => child?.once('exit', done))
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true }).catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('proxy recovery preserves other routes and requires explicit fenced repair', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'ade-proxy-recovery-e2e-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  const registry = join(dataDirectory, 'service-proxies.json')
  const userData = join(root, 'electron-user-data')
  await mkdir(dataDirectory, { mode: 0o700 })
  let child: ChildProcess | undefined
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  let hello: Record<string, unknown> | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: { ...process.env,
      ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh' },
    stdio: ['ignore', 'ignore', 'pipe'] })
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* Wait for daemon startup. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  const stop = async (): Promise<void> => {
    const running = child
    const runtimePid = hello?.runtime_pid
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => running?.exitCode).not.toBeNull()
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true })
    }
    if (typeof runtimePid === 'number') {
      await expect.poll(() => {
        try { process.kill(runtimePid, 0); return true } catch { return false }
      }).toBe(false)
    }
  }
  const route = (name: string) => ({ workspace_id: workspace.id, name, port_variable: 'PORT' })
  let workspace: { id: string }
  let occupied: ReturnType<typeof createServer> | undefined
  let occupiedRetired: ReturnType<typeof createServer> | undefined
  let occupiedUi: ReturnType<typeof createServer> | undefined
  try {
    await launch()
    workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    for (const name of ['one', 'two', 'three', 'four']) {
      await rpc(socket, { op: 'service.configure', workspace_id: workspace.id, name,
        revision: 0, config: { program: process.execPath,
          args: ['-e', 'require("node:http").createServer((_,res)=>res.end(process.env.NAME)).listen(Number(process.env.PORT),"127.0.0.1");setInterval(()=>{},1000)'],
          env: { NAME: name }, cwd: '.', ports: ['PORT'] } })
    }
    const first = await rpc(socket, { op: 'service.proxy.ensure', ...route('one') })
    const second = await rpc(socket, { op: 'service.proxy.ensure', ...route('two') })
    const third = await rpc(socket, { op: 'service.proxy.ensure', ...route('three') })
    const fourth = await rpc(socket, { op: 'service.proxy.ensure', ...route('four') })
    await stop()

    occupied = createServer()
    await new Promise<void>((done, fail) => {
      occupied!.once('error', (error) => fail(new Error(`Could not occupy saved one proxy port ${first.port}: ${error}`)))
      occupied!.listen(Number(first.port), '127.0.0.1', () => done())
    })
    occupiedRetired = createServer()
    await new Promise<void>((done, fail) => {
      occupiedRetired!.once('error', (error) => fail(new Error(`Could not occupy saved three proxy port ${third.port}: ${error}`)))
      occupiedRetired!.listen(Number(third.port), '127.0.0.1', () => done())
    })
    occupiedUi = createServer()
    await new Promise<void>((done, fail) => {
      occupiedUi!.once('error', (error) => fail(new Error(`Could not occupy saved four proxy port ${fourth.port}: ${error}`)))
      occupiedUi!.listen(Number(fourth.port), '127.0.0.1', () => done())
    })
    await launch()
    const degraded = await rpc(socket, { op: 'service.proxy.recovery.inspect' })
    expect(degraded.status).toBe('degraded')
    expect((degraded.routes as { route_id: string; availability: string }[])
      .find((item) => item.route_id === first.route_id)).toMatchObject({
        availability: 'port_occupied', workspace_id: workspace.id, name: 'one', port_variable: 'PORT',
      })
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('one') })))
      .toMatchObject({ route_id: first.route_id, port: first.port,
        url: null, availability: 'port_occupied' })
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('two') })).url).toBe(second.url)
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('three') })))
      .toMatchObject({ route_id: third.route_id, url: null, availability: 'port_occupied' })
    await expect(rpc(socket, { op: 'service.proxy.ensure', ...route('one') }))
      .rejects.toThrow(/port is unavailable/)
    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'two' })
    await expect.poll(async () => (await (await fetch(second.url as string)).text())).toBe('two')
    application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...process.env, ADE_SOCKET: socket, ADE_E2E_USER_DATA_DIR: userData, ADE_E2E_HIDE_WINDOW: '1' } })
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const services = window.getByRole('region', { name: 'Workspace services' })
    await services.getByRole('button', { name: 'Inspect URL recovery' }).click()
    const recovery = services.getByRole('region', { name: 'URL recovery' })
    await expect(recovery).toContainText('Local URL registry: degraded')
    await expect(recovery).toContainText(`four.PORT: original local URL on port ${fourth.port} is blocked`)
    await recovery.getByRole('button', { name: 'Retire blocked URL for three.PORT' }).click()
    await expect(recovery.getByRole('button', { name: 'Retire blocked URL for three.PORT' })).toHaveCount(0)
    await expect(rpc(socket, { op: 'service.proxy.inspect', ...route('three') }))
      .rejects.toThrow(/does not exist/)
    const retry = { op: 'service.proxy.recovery.retry', ...route('one'),
      expected_route_id: first.route_id, expected_service_identity: first.service_identity,
      expected_target_port: first.target_port, expected_proxy_port: first.port }
    await expect(rpc(socket, { ...retry, expected_route_id: 'route_stale' }))
      .rejects.toThrow(/route changed/)
    await expect(rpc(socket, retry)).rejects.toThrow(/port remains unavailable/)
    await new Promise<void>((done, fail) => occupiedUi!.close((error) => error ? fail(error) : done()))
    occupiedUi = undefined
    await recovery.getByRole('button', { name: 'Retry original URL for four.PORT' }).click()
    await expect(recovery).toContainText('Local URL registry: degraded')
    await expect(recovery.getByRole('button', { name: 'Retry original URL for four.PORT' })).toHaveCount(0)
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('four') })).url).toBe(fourth.url)
    await application.close()
    application = undefined
    await new Promise<void>((done, fail) => occupied!.close((error) => error ? fail(error) : done()))
    occupied = undefined
    const retried = await execFileAsync(process.execPath, [resolve('apps/cli/dist/index.js'),
      '--socket', socket, 'service', 'url-retry', workspace.id, 'one', 'PORT',
      first.route_id as string, first.service_identity as string,
      String(first.target_port), String(first.port)])
    expect(JSON.parse(retried.stdout).url).toBe(first.url)
    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'one' })
    await expect.poll(async () => (await (await fetch(first.url as string)).text())).toBe('one')
    await expect.poll(async () => (await (await fetch(second.url as string)).text())).toBe('two')

    await stop()
    const saved = await readFile(registry)
    const broken = Buffer.from('{broken proxy registry')
    await writeFile(registry, broken)
    await launch()
    const corrupt = await rpc(socket, { op: 'service.proxy.recovery.inspect' })
    expect(corrupt).toMatchObject({ status: 'corrupt', routes: [] })
    expect(corrupt.registry_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(registry)).toEqual(broken)
    await expect(rpc(socket, { op: 'service.proxy.ensure', ...route('two') }))
      .rejects.toThrow(/registry is corrupt/)
    await expect(rpc(socket, { op: 'service.proxy.recovery.reset',
      expected_registry_sha256: '0'.repeat(64) })).rejects.toThrow(/registry changed/)
    expect(await readFile(registry)).toEqual(broken)

    // An operator may restore known-good registry bytes offline. Neither route
    // was deleted or silently assigned a replacement URL by the corrupt boot.
    await stop()
    await writeFile(registry, saved)
    await launch()
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('one') })))
      .toMatchObject({ route_id: first.route_id, url: first.url })
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('two') })))
      .toMatchObject({ route_id: second.route_id, url: second.url })

    await stop()
    const duplicate = JSON.parse(saved.toString()) as { route_id: string }[]
    duplicate[1]!.route_id = duplicate[0]!.route_id
    await writeFile(registry, JSON.stringify(duplicate))
    await launch()
    expect((await rpc(socket, { op: 'service.proxy.recovery.inspect' })).status).toBe('corrupt')
    await stop()
    await writeFile(registry, Buffer.alloc(4 * 1024 * 1024 + 1))
    await launch()
    const oversized = await rpc(socket, { op: 'service.proxy.recovery.inspect' })
    expect(oversized).toMatchObject({ status: 'corrupt', registry_sha256: '' })
    await expect(rpc(socket, { op: 'service.proxy.recovery.reset',
      expected_registry_sha256: '0'.repeat(64) })).rejects.toThrow(/offline recovery/)
    await stop()
    await rm(registry)
    await mkdir(registry)
    await launch()
    const nonregular = await rpc(socket, { op: 'service.proxy.recovery.inspect' })
    expect(nonregular).toMatchObject({ status: 'corrupt', registry_sha256: '' })
    await expect(rpc(socket, { op: 'service.proxy.recovery.reset',
      expected_registry_sha256: '0'.repeat(64) })).rejects.toThrow(/offline recovery/)
    await stop()
    await rm(registry, { recursive: true })
    await execFileAsync('mkfifo', [registry])
    await launch()
    const fifo = await rpc(socket, { op: 'service.proxy.recovery.inspect' })
    expect(fifo).toMatchObject({ status: 'corrupt', registry_sha256: '' })
    await expect(rpc(socket, { op: 'service.proxy.recovery.reset',
      expected_registry_sha256: '0'.repeat(64) })).rejects.toThrow(/offline recovery/)
    await stop()
    await rm(registry)
    await writeFile(registry, broken)
    await launch()
    const current = await rpc(socket, { op: 'service.proxy.recovery.inspect' })
    await writeFile(registry, '{new corruption')
    await expect(rpc(socket, { op: 'service.proxy.recovery.reset',
      expected_registry_sha256: current.registry_sha256 })).rejects.toThrow(/registry changed/)
    await writeFile(registry, broken)
    application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...process.env, ADE_SOCKET: socket, ADE_E2E_USER_DATA_DIR: userData, ADE_E2E_HIDE_WINDOW: '1' } })
    const recoveryWindow = await application.firstWindow()
    await expect(recoveryWindow.locator('header').getByRole('status')).toHaveText('connected')
    const recoveryServices = recoveryWindow.getByRole('region', { name: 'Workspace services' })
    await recoveryServices.getByRole('button', { name: 'Inspect URL recovery' }).click()
    const corruptPanel = recoveryServices.getByRole('region', { name: 'URL recovery' })
    await expect(corruptPanel).toContainText('Local URL registry: corrupt')
    await corruptPanel.getByRole('button', { name: 'Review archive and reset' }).click()
    await expect(corruptPanel).toContainText('Reset discards saved URL routes')
    await corruptPanel.getByRole('button', { name: 'Cancel' }).click()
    expect(await readFile(registry)).toEqual(broken)
    await corruptPanel.getByRole('button', { name: 'Review archive and reset' }).click()
    await corruptPanel.getByRole('button', { name: 'Confirm archive and reset' }).click()
    await expect(corruptPanel).toContainText('Local URL registry: healthy')
    await expect(corruptPanel).toContainText('Previous registry archived at')
    expect((await rpc(socket, { op: 'service.proxy.recovery.inspect' })).status).toBe('healthy')
    await application.close()
    application = undefined

    await stop()
    await writeFile(registry, broken)
    await launch()
    const resetCommand = await execFileAsync(process.execPath, [resolve('apps/cli/dist/index.js'),
      '--socket', socket, 'service', 'url-recovery-reset',
      current.registry_sha256 as string, '--confirm-reset'])
    const reset = JSON.parse(resetCommand.stdout)
    expect(reset).toMatchObject({ type: 'service_proxy_recovery_reset', status: 'reset' })
    expect(await readFile(reset.archive as string)).toEqual(broken)
    expect((await rpc(socket, { op: 'service.proxy.recovery.inspect' })).status).toBe('healthy')
    await expect(rpc(socket, { op: 'service.proxy.inspect', ...route('two') }))
      .rejects.toThrow(/does not exist/)
    const afterReset = await rpc(socket, { op: 'service.proxy.ensure', ...route('two') })
    expect(afterReset.route_id).not.toBe(second.route_id)
    await stop()
    await launch()
    expect((await rpc(socket, { op: 'service.proxy.inspect', ...route('two') })).route_id)
      .toBe(afterReset.route_id)
  } finally {
    if (occupied?.listening) {
      await new Promise<void>((done) => occupied!.close(() => done()))
    }
    if (occupiedRetired?.listening) {
      await new Promise<void>((done) => occupiedRetired!.close(() => done()))
    }
    if (occupiedUi?.listening) {
      await new Promise<void>((done) => occupiedUi!.close(() => done()))
    }
    await application?.close()
    if (child && child.exitCode === null && hello) {
      await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id }).catch(() => undefined)
    }
    if (child && child.exitCode === null) child.kill()
    if (child && child.exitCode === null) await new Promise((done) => child?.once('exit', done))
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true }).catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
})
