import { expect, test, _electron as electron } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

test('managed service peers resolve only a verified workspace listener and expose effective URLs', async () => {
  const daemon = await startDaemon()
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const api = (await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'api', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        args: ['-e', 'require("http").createServer((_,res)=>res.end("peer-api")).listen(Number(process.env.PORT),"127.0.0.1")'],
      },
    })).service as { ports: { PORT: number } }
    const web = (await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        peers: { API_URL: { service: 'api', port_variable: 'PORT' } },
        args: ['-e', 'require("http").createServer(async(_,res)=>{try{res.end(await (await fetch(process.env.API_URL)).text())}catch(e){res.statusCode=503;res.end(String(e))}}).listen(Number(process.env.PORT),"127.0.0.1")'],
      },
    })).service as { ports: { PORT: number } }

    await expect(rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' }))
      .rejects.toThrow(/Peer service api is stopped/)
    const unavailable = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id,
      name: 'web', tail_bytes: 256 })
    expect(unavailable.effective_peers).toEqual({})
    expect(unavailable.peer_error).toContain('Peer service api is stopped')
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'api' })
    await expect.poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${api.ports.PORT}/`)).text() }
      catch { return '' }
    }).toBe('peer-api')
    const started = await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    expect(started.effective_peers).toEqual({ API_URL: `http://127.0.0.1:${api.ports.PORT}` })
    const alreadyRunning = await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    expect(alreadyRunning.effective_peers).toEqual(started.effective_peers)
    expect((alreadyRunning.service as { terminal_owner: { transfer_id: string } }).terminal_owner.transfer_id)
      .toBe((started.service as { terminal_owner: { transfer_id: string } }).terminal_owner.transfer_id)
    const inspected = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id,
      name: 'web', tail_bytes: 256 })
    expect(inspected.effective_peers).toEqual(started.effective_peers)
    expect(inspected.peer_error).toBeNull()
    await expect.poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${web.ports.PORT}/`)).text() }
      catch { return '' }
    }).toBe('peer-api')

    application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...process.env, ADE_SOCKET: daemon.socket,
        ADE_E2E_USER_DATA_DIR: join(daemon.rootDirectory, 'electron') } })
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const row = window.getByRole('article', { name: 'Service web' })
    await expect(row).toContainText('API_URL ← api.PORT')
    await row.getByRole('button', { name: 'Inspect' }).click()
    await expect(row).toContainText(`Effective API_URL: http://127.0.0.1:${api.ports.PORT}`)
    await application.close()
    application = undefined

    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'bad-launch', revision: 0, config: {
        program: join(daemon.rootDirectory, 'missing-executable'), cwd: '.', env: {}, ports: [],
        peers: { API_URL: { service: 'api', port_variable: 'PORT' } },
      },
    })
    await expect(rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'bad-launch' }))
      .rejects.toThrow()
    const failedLaunch = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id,
      name: 'bad-launch', tail_bytes: 256 })
    expect(failedLaunch.effective_peers).toEqual({})
    expect(failedLaunch.execution_state).not.toBe('running')
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'bad-launch' })

    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'api' })
    const retained = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id,
      name: 'web', tail_bytes: 256 })
    expect(retained.effective_peers).toEqual({ API_URL: `http://127.0.0.1:${api.ports.PORT}` })
    expect(retained.current_peer_endpoints).toEqual({})
    expect(retained.peer_error).toContain('Peer service api is stopped')
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    await expect(rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' }))
      .rejects.toThrow(/Peer service api is stopped/)
    const afterStop = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id,
      name: 'web', tail_bytes: 256 })
    expect(afterStop.effective_peers).toEqual({})
    expect(afterStop.peer_error).toContain('Peer service api is stopped')

    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'first', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        peers: { SECOND_URL: { service: 'second', port_variable: 'PORT' } },
      },
    })
    await expect(rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'second', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        peers: { FIRST_URL: { service: 'first', port_variable: 'PORT' } },
      },
    })).rejects.toThrow(/dependency cycle/)
    await expect(rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'bad-env', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        peers: { TERM: { service: 'api', port_variable: 'PORT' } },
      },
    })).rejects.toThrow(/Invalid peer service endpoints/)
  } finally {
    await application?.close()
    await daemon.stop()
  }
})

test('a daemon handoff retains the URLs given to a running peer-dependent service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-peer-handoff-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  await mkdir(dataDirectory, { mode: 0o700 })
  let child: ChildProcess | undefined
  let hello: Record<string, unknown> | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: { ...process.env,
      ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh' },
    stdio: ['ignore', 'ignore', 'pipe'] })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* Wait for the daemon endpoint. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  try {
    await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const api = (await rpc(socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'api', revision: 0, config: { program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        args: ['-e', 'require("http").createServer((_,res)=>res.end("handoff-api")).listen(Number(process.env.PORT),"127.0.0.1")'] },
    })).service as { ports: { PORT: number } }
    await rpc(socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'web', revision: 0, config: { program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        peers: { API_URL: { service: 'api', port_variable: 'PORT' } },
        args: ['-e', 'require("http").createServer(async(_,res)=>res.end(await (await fetch(process.env.API_URL)).text())).listen(Number(process.env.PORT),"127.0.0.1")'] },
    })
    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'api' })
    await expect.poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${api.ports.PORT}`)).text() }
      catch { return '' }
    }).toBe('handoff-api')
    const started = await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    const transfer = (started.service as { terminal_owner: { transfer_id: string } }).terminal_owner.transfer_id
    const expected = { API_URL: `http://127.0.0.1:${api.ports.PORT}` }
    const original = await rpc(socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'web', tail_bytes: 256 })
    expect(original.effective_peers).toEqual(expected)

    const oldChild = child
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => oldChild?.exitCode).not.toBeNull()
    await launch()
    const after = await rpc(socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'web', tail_bytes: 256 })
    expect(after).toMatchObject({ execution_state: 'running', effective_peers: expected,
      current_peer_endpoints: expected })
    const repeated = await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    expect((repeated.service as { terminal_owner: { transfer_id: string } }).terminal_owner.transfer_id).toBe(transfer)
    expect(repeated.effective_peers).toEqual(expected)
    await rpc(socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    await rpc(socket, { op: 'service.stop', workspace_id: workspace.id, name: 'api' })
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

test('an IPv6-only managed peer receives a verified loopback URL', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const api = (await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'ipv6-api', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        args: ['-e', 'require("http").createServer((_,res)=>res.end("ipv6-peer")).listen(Number(process.env.PORT),"::1")'],
      },
    })).service as { ports: { PORT: number } }
    const web = (await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'ipv6-web', revision: 0, config: {
        program: process.execPath, cwd: '.', env: {}, ports: ['PORT'],
        peers: { API_URL: { service: 'ipv6-api', port_variable: 'PORT' } },
        args: ['-e', 'require("http").createServer(async(_,res)=>res.end(await (await fetch(process.env.API_URL)).text())).listen(Number(process.env.PORT),"127.0.0.1")'],
      },
    })).service as { ports: { PORT: number } }
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'ipv6-api' })
    await expect.poll(async () => {
      try { return await (await fetch(`http://[::1]:${api.ports.PORT}/`)).text() }
      catch { return '' }
    }).toBe('ipv6-peer')
    const inventory = await rpc(daemon.socket, { op: 'listener.list' })
    expect((inventory.listeners as { family: string; port: number }[])
      .some((listener) => listener.port === api.ports.PORT && listener.family === 'ipv6')).toBe(true)
    const started = await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'ipv6-web' })
    expect(started.effective_peers).toEqual({ API_URL: `http://[::1]:${api.ports.PORT}` })
    await expect.poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${web.ports.PORT}/`)).text() }
      catch { return '' }
    }).toBe('ipv6-peer')
    const observed = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id,
      name: 'ipv6-web', tail_bytes: 256 })
    expect(observed.current_peer_endpoints).toEqual(started.effective_peers)
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'ipv6-web' })
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'ipv6-api' })
  } finally {
    await daemon.stop()
  }
})
