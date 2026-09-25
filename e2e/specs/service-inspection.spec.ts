import { expect, test } from '@playwright/test'
import { rpc, startDaemon } from '../fixtures/daemon'

type Inspection = {
  execution_state: string
  execution_error?: string
  readiness: { state: string; basis: string; application_ready: string }
  logs: { available: boolean; bytes_base64?: string; start_offset?: number; through_offset?: number; truncated?: boolean }
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
