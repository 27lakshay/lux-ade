import { expect, test } from '@playwright/test'
import { createServer } from 'node:net'
import { rpc, startDaemon } from '../fixtures/daemon'

type Inspection = {
  execution_state: string
  execution_error?: string
  readiness: { state: string; basis: string; application_ready: string }
  logs: { available: boolean; bytes_base64?: string; start_offset?: number; through_offset?: number; truncated?: boolean }
  health?: { state: string; basis: string; status_code?: number; port_variable?: string; path?: string }
}

test('service inspection reports listener evidence and a bounded PTY output tail', async () => {
  const daemon = await startDaemon()
  try {
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const configure = async (name: string, script: string): Promise<void> => {
      await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id, name, revision: 0,
        config: { program: process.execPath, args: ['-e', script], cwd: '.', env: {}, ports: ['PORT'] },
      })
    }
    const inspect = (name: string, tailBytes = 2048): Promise<Inspection> =>
      rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name, tail_bytes: tailBytes }) as Promise<Inspection>

    await configure('web', 'process.stdout.write("X".repeat(50000)); console.log("ADE_SERVICE_MARKER"); require("http").createServer((_,res)=>res.end("ready")).listen(Number(process.env.PORT),"127.0.0.1")')
    const before = await inspect('web')
    expect(before.execution_state).toBe('stopped')
    expect(before.readiness).toMatchObject({ state: 'stopped', application_ready: 'unverified' })
    expect(before.logs).toMatchObject({ available: false, reason: 'not_started' })

    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => (await inspect('web')).readiness.state).toBe('tcp_listening')
    const running = await inspect('web')
    expect(running.execution_state).toBe('running')
    expect(running.readiness).toMatchObject({ basis: 'direct_process_tcp_listener', application_ready: 'unverified' })
    expect(running.logs.available).toBe(true)
    expect(Buffer.from(running.logs.bytes_base64 ?? '', 'base64').toString()).toContain('ADE_SERVICE_MARKER')
    expect(running.logs.truncated).toBe(true)
    expect(running.logs.start_offset).toBeGreaterThan(0)
    expect(running.logs.through_offset).toBeGreaterThan(running.logs.start_offset)
    expect((running.logs.through_offset ?? 0) - (running.logs.start_offset ?? 0)).toBeLessThanOrEqual(2048)

    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    const stopped = await inspect('web')
    expect(stopped.execution_state).toBe('stopped')
    expect(stopped.readiness.state).toBe('stopped')
    expect(Buffer.from(stopped.logs.bytes_base64 ?? '', 'base64').toString()).toContain('ADE_SERVICE_MARKER')

    await configure('idle', 'console.log("ADE_IDLE_MARKER"); setInterval(()=>{},1000)')
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'idle' })
    await expect.poll(async () => (await inspect('idle')).execution_state).toBe('running')
    const idle = await inspect('idle')
    expect(idle.readiness.state).toBe('not_observed')
    expect(Buffer.from(idle.logs.bytes_base64 ?? '', 'base64').toString()).toContain('ADE_IDLE_MARKER')
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'idle' })

    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'missing' })).rejects.toThrow('Unknown workspace service')
    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'web', tail_bytes: 0 })).rejects.toThrow('Tail limit')
    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'web', tail_bytes: 32769 })).rejects.toThrow('Tail limit')
  } finally {
    await daemon.stop()
  }
})

test('explicit HTTP health checks use the managed port and discard results after stop', async () => {
  const daemon = await startDaemon()
  const notify = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      notify.once('error', reject)
      notify.listen(0, '127.0.0.1', resolve)
    })
    const notifyAddress = notify.address()
    if (!notifyAddress || typeof notifyAddress === 'string') throw new Error('Missing fixture notification port')
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const script = `require('http').createServer((req,res)=>{
      if(req.url==='/slow'){console.log('HEALTH_SLOW_ENTER');return}
      if(req.url==='/hold'){require('net').connect(Number(process.env.HEALTH_NOTIFY_PORT),'127.0.0.1').end();return}
      if(req.url==='/redirect'){res.writeHead(302,{Location:'http://example.com/'});res.end();return}
      res.statusCode=req.url==='/unhealthy'?503:200;res.end('ok')
    }).listen(Number(process.env.PORT),'127.0.0.1')`
    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id, name: 'health', revision: 0,
      config: { program: process.execPath, args: ['-e', script], cwd: '.',
        env: { HEALTH_NOTIFY_PORT: String(notifyAddress.port) }, ports: ['PORT'] },
    })
    const inspect = (path: string, timeout_ms = 500): Promise<Inspection> =>
      rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'health',
        health_check: { port_variable: 'PORT', path, timeout_ms } }) as Promise<Inspection>
    expect((await inspect('/healthy')).health).toMatchObject({ state: 'not_running', basis: 'execution_state' })
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'health' })
    await expect.poll(async () => (await inspect('/healthy')).health?.state).toBe('healthy')
    expect((await inspect('/healthy')).health).toMatchObject({ state: 'healthy', basis: 'http_status', status_code: 200,
      port_variable: 'PORT', path: '/healthy' })
    expect((await inspect('/unhealthy')).health).toMatchObject({ state: 'unhealthy', status_code: 503 })
    expect((await inspect('/redirect')).health).toMatchObject({ state: 'unhealthy', status_code: 302 })
    expect((await inspect('/slow', 100)).health?.state).toBe('timeout')
    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'health',
      health_check: { port_variable: 'OTHER', path: '/healthy', timeout_ms: 500 } })).rejects.toThrow('not configured')
    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'health',
      health_check: { port_variable: 'PORT', path: 'http://example.com/', timeout_ms: 500 } })).rejects.toThrow('HTTP health path')
    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'health',
      health_check: { port_variable: 'PORT', path: '/healthy\r\nHost: example.com', timeout_ms: 500 } })).rejects.toThrow('HTTP health path')
    await expect(rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'health',
      health_check: { port_variable: 'PORT', path: '/healthy', timeout_ms: 2001 } })).rejects.toThrow('HTTP health timeout')

    const notification = new Promise<void>(resolve => notify.once('connection', socket => {
      socket.destroy()
      resolve()
    }))
    const pending = inspect('/hold', 2000)
    await Promise.race([notification, pending.then(() => { throw new Error('HTTP probe finished before the fixture notified the test') })])
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'health' })
    expect((await pending).health).toMatchObject({ state: 'unknown' })
    expect((await inspect('/healthy')).health?.state).toBe('not_running')
  } finally {
    await daemon.stop()
    if (notify.listening) await new Promise<void>((resolve, reject) => notify.close(error => error ? reject(error) : resolve()))
  }
})

test('service inspection keeps configured identity when its isolated supervisor disappears', async () => {
  const daemon = await startDaemon()
  try {
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id, name: 'web', revision: 0,
      config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: '.', env: {}, ports: ['PORT'] },
    })
    const runtime = await rpc(daemon.socket, { op: 'runtime.status' })
    const runtimePid = runtime.runtime_pid as number
    expect(runtimePid).toBeGreaterThan(0)
    process.kill(runtimePid, 'SIGKILL')
    await expect.poll(async () => {
      const result = await rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'web' }) as Inspection
      return { state: result.execution_state, readiness: result.readiness.state, logs: result.logs.available,
        service: (result as unknown as { service: { name: string } }).service.name }
    }).toEqual({ state: 'unavailable', readiness: 'unknown', logs: false, service: 'web' })
  } finally {
    await daemon.stop().catch(() => undefined)
  }
})
