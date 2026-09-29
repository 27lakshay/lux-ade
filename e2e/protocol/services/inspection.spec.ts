// F086 service inspection: listener readiness evidence, a bounded output tail,
// recurring configured HTTP health that never carries a stopped run into its
// successor, explicit health checks against the managed port, and inspection
// after the runtime is lost. Ported from the legacy e2e/specs/service-inspection spec.
import { createServer } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { logText } from '../fixtures/services'

type Inspection = {
  execution_state: string
  readiness: { state: string; basis: string; application_ready: string }
  logs: { available: boolean; start_offset?: number; through_offset?: number; truncated?: boolean }
  health?: { state: string; basis?: string; status_code?: number; port_variable?: string; path?: string }
  health_monitor?: { state: string; basis?: string; status_code?: number; sampled_at_ms?: number }
  service: { name: string }
}

async function defaultWorkspace(profile: ScratchProfile): Promise<string> {
  return (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace.id
}

function scriptService(script: string, extra: Record<string, unknown> = {}) {
  return { program: process.execPath, args: ['-e', script], cwd: '.', env: {}, ports: ['PORT'], ...extra }
}

async function configure(profile: ScratchProfile, workspace_id: string, name: string, config: unknown) {
  return (await profile.call('service.configure', { workspace_id, name, revision: 0, config } as never)).service
}

async function inspect(
  profile: ScratchProfile,
  workspace_id: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<Inspection> {
  return (await profile.call('service.inspect', { workspace_id, name, ...extra } as never)) as unknown as Inspection
}

test('service inspection reports listener evidence and a bounded PTY output tail', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  const view = (name: string) => inspect(profile, workspace_id, name, { tail_bytes: 2048 })
  await configure(
    profile,
    workspace_id,
    'web',
    scriptService(
      'process.stdout.write("X".repeat(50000)); console.log("ADE_SERVICE_MARKER"); require("http").createServer((_,res)=>res.end("ready")).listen(Number(process.env.PORT),"127.0.0.1")',
    ),
  )
  const before = await view('web')
  expect(before.execution_state).toBe('stopped')
  expect(before.readiness).toMatchObject({ state: 'stopped', application_ready: 'unverified' })
  expect(before.logs).toMatchObject({ available: false, reason: 'not_started' })

  await profile.call('service.start', { workspace_id, name: 'web' })
  await expect.poll(async () => (await view('web')).readiness.state).toBe('tcp_listening')
  const running = await view('web')
  expect(running.execution_state).toBe('running')
  expect(running.readiness).toMatchObject({ basis: 'direct_process_tcp_listener', application_ready: 'unverified' })
  expect(running.logs.available).toBe(true)
  expect(logText(running.logs)).toContain('ADE_SERVICE_MARKER')
  expect(running.logs.truncated).toBe(true)
  expect(running.logs.start_offset).toBeGreaterThan(0)
  expect(running.logs.through_offset).toBeGreaterThan(running.logs.start_offset!)
  expect((running.logs.through_offset ?? 0) - (running.logs.start_offset ?? 0)).toBeLessThanOrEqual(2048)

  await profile.call('service.stop', { workspace_id, name: 'web' })
  const stopped = await view('web')
  expect(stopped.execution_state).toBe('stopped')
  expect(stopped.readiness.state).toBe('stopped')
  expect(logText(stopped.logs)).toContain('ADE_SERVICE_MARKER')

  // A running process with no listener is not claimed ready.
  await configure(
    profile,
    workspace_id,
    'idle',
    scriptService('console.log("ADE_IDLE_MARKER"); setInterval(()=>{},1000)'),
  )
  await profile.call('service.start', { workspace_id, name: 'idle' })
  await expect.poll(async () => (await view('idle')).execution_state).toBe('running')
  const idle = await view('idle')
  expect(idle.readiness.state).toBe('not_observed')
  expect(logText(idle.logs)).toContain('ADE_IDLE_MARKER')
  await profile.call('service.stop', { workspace_id, name: 'idle' })

  await expect(inspect(profile, workspace_id, 'missing')).rejects.toThrow('Unknown workspace service')
  await expect(profile.rpc({ op: 'service.inspect', workspace_id, name: 'web', tail_bytes: 0 })).rejects.toThrow(
    'Tail limit',
  )
  await expect(profile.rpc({ op: 'service.inspect', workspace_id, name: 'web', tail_bytes: 32769 })).rejects.toThrow(
    'Tail limit',
  )
})

test('configured HTTP health samples recur and never carry a stopped run into its successor', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  const statusFile = join(profile.defaultWorkspaceRoot, 'health-status.txt')
  await writeFile(statusFile, '503')
  const script = `require('http').createServer((_,res)=>{
    res.statusCode=Number(require('fs').readFileSync('health-status.txt','utf8'))
    res.end('status')
  }).listen(Number(process.env.PORT),'127.0.0.1')`
  await expect(
    configure(
      profile,
      workspace_id,
      'invalid-health',
      scriptService(script, {
        health: { port_variable: 'PORT', path: '/health', timeout_ms: 2000, interval_ms: 1000 },
      }),
    ),
  ).rejects.toThrow('HTTP health interval')
  await configure(
    profile,
    workspace_id,
    'monitored',
    scriptService(script, { health: { port_variable: 'PORT', path: '/health', timeout_ms: 250, interval_ms: 1000 } }),
  )
  const view = () => inspect(profile, workspace_id, 'monitored')
  const sample = async () =>
    (await profile.call('service.health.sample', { workspace_id, name: 'monitored' }))
      .health_monitor as Inspection['health_monitor']
  expect((await view()).health_monitor?.state).toBe('not_running')
  await profile.call('service.start', { workspace_id, name: 'monitored' })
  await expect.poll(async () => (await view()).health_monitor?.state).toBe('unhealthy')
  expect((await view()).health_monitor).toMatchObject({ basis: 'http_status', status_code: 503 })

  await writeFile(statusFile, '200')
  expect(await sample()).toMatchObject({ state: 'healthy', status_code: 200 })
  // Samples keep recurring without being asked.
  await writeFile(statusFile, '503')
  await expect.poll(async () => (await view()).health_monitor?.status_code).toBe(503)
  await writeFile(statusFile, '200')
  const beforeStop = await sample()
  expect(beforeStop?.state).toBe('healthy')
  const firstSample = beforeStop?.sampled_at_ms ?? 0
  expect(firstSample).toBeGreaterThan(0)

  // The stopped run's healthy sample never shows for its successor.
  await profile.call('service.stop', { workspace_id, name: 'monitored' })
  expect((await view()).health_monitor?.state).toBe('not_running')
  await writeFile(statusFile, '503')
  await profile.call('service.start', { workspace_id, name: 'monitored' })
  expect((await view()).health_monitor?.state).not.toBe('healthy')
  await expect.poll(async () => (await view()).health_monitor?.state).toBe('unhealthy')
  expect((await view()).health_monitor?.sampled_at_ms).toBeGreaterThan(firstSample)
  await profile.call('service.stop', { workspace_id, name: 'monitored' })
})

test('an exited first service cannot starve a second service at the minimum interval', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  const health = { port_variable: 'PORT', path: '/health', timeout_ms: 100, interval_ms: 250 }
  await configure(profile, workspace_id, 'a-exited', scriptService('process.exit(1)', { health }))
  await configure(
    profile,
    workspace_id,
    'z-healthy',
    scriptService('require("http").createServer((_,res)=>res.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")', {
      health,
    }),
  )
  await profile.call('service.start', { workspace_id, name: 'a-exited' })
  await expect.poll(async () => (await inspect(profile, workspace_id, 'a-exited')).execution_state).toBe('exited')
  await profile.call('service.start', { workspace_id, name: 'z-healthy' })
  const healthy = () => inspect(profile, workspace_id, 'z-healthy')
  await expect.poll(async () => (await healthy()).health_monitor?.state).toBe('healthy')
  const first = (await healthy()).health_monitor?.sampled_at_ms ?? 0
  await expect.poll(async () => (await healthy()).health_monitor?.sampled_at_ms ?? 0).toBeGreaterThan(first)
  await profile.call('service.stop', { workspace_id, name: 'a-exited' })
  await profile.call('service.stop', { workspace_id, name: 'z-healthy' })
})

test('explicit HTTP health checks use the managed port and discard results after stop', async ({ profile }) => {
  const notify = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    notify.once('error', rejectListen)
    notify.listen(0, '127.0.0.1', resolveListen)
  })
  try {
    const notifyAddress = notify.address()
    if (!notifyAddress || typeof notifyAddress === 'string') throw new Error('Missing fixture notification port')
    const workspace_id = await defaultWorkspace(profile)
    const script = `require('http').createServer((req,res)=>{
      if(req.url==='/slow'){console.log('HEALTH_SLOW_ENTER');return}
      if(req.url==='/hold'){require('net').connect(Number(process.env.HEALTH_NOTIFY_PORT),'127.0.0.1').end();return}
      if(req.url==='/redirect'){res.writeHead(302,{Location:'http://example.com/'});res.end();return}
      res.statusCode=req.url==='/unhealthy'?503:200;res.end('ok')
    }).listen(Number(process.env.PORT),'127.0.0.1')`
    await configure(
      profile,
      workspace_id,
      'health',
      scriptService(script, { env: { HEALTH_NOTIFY_PORT: String(notifyAddress.port) } }),
    )
    const check = (path: string, timeout_ms = 500, port_variable = 'PORT') =>
      inspect(profile, workspace_id, 'health', { health_check: { port_variable, path, timeout_ms } })
    expect((await check('/healthy')).health).toMatchObject({ state: 'not_running', basis: 'execution_state' })
    await profile.call('service.start', { workspace_id, name: 'health' })
    await expect.poll(async () => (await check('/healthy')).health?.state).toBe('healthy')
    expect((await check('/healthy')).health).toMatchObject({
      state: 'healthy',
      basis: 'http_status',
      status_code: 200,
      port_variable: 'PORT',
      path: '/healthy',
    })
    expect((await check('/unhealthy')).health).toMatchObject({ state: 'unhealthy', status_code: 503 })
    expect((await check('/redirect')).health).toMatchObject({ state: 'unhealthy', status_code: 302 })
    expect((await check('/slow', 100)).health?.state).toBe('timeout')
    // Refusals come from the daemon itself, so these go past the SDK's contract check.
    const raw = (path: string, timeout_ms = 500, port_variable = 'PORT') =>
      profile.rpc({
        op: 'service.inspect',
        workspace_id,
        name: 'health',
        health_check: { port_variable, path, timeout_ms },
      })
    await expect(raw('/healthy', 500, 'OTHER')).rejects.toThrow('not configured')
    await expect(raw('http://example.com/')).rejects.toThrow('HTTP health path')
    await expect(raw('/healthy\r\nHost: example.com')).rejects.toThrow('HTTP health path')
    await expect(raw('/healthy', 2001)).rejects.toThrow('HTTP health timeout')

    // A probe in flight when the service stops reports unknown, never the stopped run's health.
    const notification = new Promise<void>((resolveNotified) =>
      notify.once('connection', (socket) => {
        socket.destroy()
        resolveNotified()
      }),
    )
    const pending = check('/hold', 2000)
    await Promise.race([
      notification,
      pending.then(() => {
        throw new Error('HTTP probe finished before the fixture notified the test')
      }),
    ])
    await profile.call('service.stop', { workspace_id, name: 'health' })
    expect((await pending).health).toMatchObject({ state: 'unknown' })
    expect((await check('/healthy')).health?.state).toBe('not_running')
  } finally {
    await new Promise<void>((resolveClose) => notify.close(() => resolveClose()))
  }
})

test('service inspection keeps configured identity when its isolated supervisor disappears', async ({ profile }) => {
  const workspace_id = await defaultWorkspace(profile)
  await configure(profile, workspace_id, 'web', scriptService('setInterval(()=>{},1000)'))
  const runtime = await profile.call('runtime.status', {})
  expect(runtime.runtime_pid).toBeGreaterThan(0)
  await profile.killRuntime()
  await expect
    .poll(async () => {
      const result = await inspect(profile, workspace_id, 'web')
      return {
        state: result.execution_state,
        readiness: result.readiness.state,
        logs: result.logs.available,
        service: result.service.name,
      }
    })
    .toEqual({ state: 'unavailable', readiness: 'unknown', logs: false, service: 'web' })
})
