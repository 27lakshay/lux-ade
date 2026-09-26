import { expect, test } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { rpc } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)

test('runtime-owned service URL preserves HTTP and WebSocket traffic across service and daemon restarts', async () => {
  test.setTimeout(60_000)
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
      peer.once('data', (chunk) => {
        peer.destroy()
        done(Number(chunk.toString().split(' ')[1]))
      })
      peer.once('error', fail)
    })
  }
  const slowHeader = async (url: string): Promise<{ status: number; elapsed: number }> => {
    const started = performance.now()
    return await new Promise((done, fail) => {
      const peer = createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) })
      const deadline = setTimeout(() => peer.destroy(new Error('Slow header was not bounded')), 8_000)
      const trickle = setInterval(() => peer.write('G'), 750)
      peer.once('data', (chunk) => {
        clearTimeout(deadline)
        clearInterval(trickle)
        peer.destroy()
        done({ status: Number(chunk.toString().split(' ')[1]), elapsed: performance.now() - started })
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
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => running?.exitCode).not.toBeNull()
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true })
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
    await launch()
    const afterRestart = (await rpc(socket, { op: 'service.list', workspace_id: workspace.id }))
      .services as { name: string; identity: string }[]
    expect(afterRestart.find((service) => service.name === 'first')?.identity).toBe(firstIdentity)
    expect((await rpc(socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'first', port_variable: 'PORT' })).url).toBe(route.url)
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
