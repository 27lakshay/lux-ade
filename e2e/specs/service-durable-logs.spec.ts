import { expect, test } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, startDaemon } from '../fixtures/daemon'

type Durable = {
  available: boolean
  reason?: string
  run_transfer_id?: string
  bytes_base64?: string
  start_offset?: number
  through_offset?: number
  retained_start_offset?: number
  retention_overflow?: boolean
  truncated?: boolean
}
type Inspection = {
  durable_logs: Durable
  execution_state: string
  service: { revision: number; last_run_transfer_id?: string }
}
const output = (logs: Durable): string => Buffer.from(logs.bytes_base64 ?? '', 'base64').toString()

test('durable service output is bounded and a failed successor never exposes prior-run bytes', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (
      (await rpc(daemon.socket, { op: 'catalog.get' })).catalog as { workspaces: Array<{ id: string }> }
    ).workspaces[0]
    const inspect = (): Promise<Inspection> =>
      rpc(daemon.socket, {
        op: 'service.inspect',
        workspace_id: workspace.id,
        name: 'logs',
        tail_bytes: 4096,
      }) as Promise<Inspection>
    const configure = (program: string, args: string[], revision: number): Promise<unknown> =>
      rpc(daemon.socket, {
        op: 'service.configure',
        workspace_id: workspace.id,
        name: 'logs',
        revision,
        config: { program, args, cwd: '.', env: {}, ports: [] },
      })
    await configure(
      process.execPath,
      ['-e', 'process.stdout.write("A".repeat(1200000)); console.log("LAST_RUN_MARKER"); setInterval(()=>{},1000)'],
      0,
    )
    expect((await inspect()).durable_logs).toMatchObject({ available: false, reason: 'not_started' })
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'logs' })
    await expect.poll(async () => output((await inspect()).durable_logs)).toContain('LAST_RUN_MARKER')
    const running = (await inspect()).durable_logs
    expect(running.available).toBe(true)
    expect(running.retention_overflow).toBe(true)
    expect(running.truncated).toBe(true)
    expect(running.retained_start_offset).toBeGreaterThan(0)
    expect((running.through_offset ?? 0) - (running.start_offset ?? 0)).toBeLessThanOrEqual(4096)
    const prior = running.run_transfer_id
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'logs' })
    expect(output((await inspect()).durable_logs)).toContain('LAST_RUN_MARKER')
    await configure('/nonexistent/ade-service-program', [], (await inspect()).service.revision)
    await expect(
      rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'logs' }),
    ).rejects.toThrow()
    const afterFailedStart = await inspect()
    const failed = afterFailedStart.durable_logs
    expect(failed.available).toBe(false)
    expect(afterFailedStart.service.last_run_transfer_id).toBeTruthy()
    expect(afterFailedStart.service.last_run_transfer_id).not.toBe(prior)
    expect(output(failed)).not.toContain('LAST_RUN_MARKER')
  } finally {
    await daemon.stop()
  }
})

test('durable service output survives daemon handoff and remains readable after runtime loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-durable-service-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  await mkdir(dataDirectory, { mode: 0o700 })
  let child: ChildProcess | undefined
  let hello: Record<string, unknown> | undefined
  let servicePid: number | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], {
      env: { ...process.env, ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch {
        /* Waiting for the socket. */
      }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  try {
    await launch()
    const workspace = ((await rpc(socket, { op: 'catalog.get' })).catalog as { workspaces: Array<{ id: string }> })
      .workspaces[0]
    const inspect = (): Promise<Inspection> =>
      rpc(socket, {
        op: 'service.inspect',
        workspace_id: workspace.id,
        name: 'restart',
        tail_bytes: 4096,
      }) as Promise<Inspection>
    await rpc(socket, {
      op: 'service.configure',
      workspace_id: workspace.id,
      name: 'restart',
      revision: 0,
      config: {
        program: process.execPath,
        args: ['-e', 'console.log("DURABLE_RESTART_MARKER"); setInterval(()=>{},1000)'],
        cwd: '.',
        env: {},
        ports: [],
      },
    })
    await rpc(socket, { op: 'service.start', workspace_id: workspace.id, name: 'restart' })
    await expect.poll(async () => output((await inspect()).durable_logs)).toContain('DURABLE_RESTART_MARKER')
    const transfer = (await inspect()).durable_logs.run_transfer_id
    const listed = (await rpc(socket, { op: 'service.list', workspace_id: workspace.id })) as {
      states: Record<string, { metrics?: { shell_pid?: number } }>
    }
    servicePid = listed.states.restart.metrics?.shell_pid
    const oldChild = child
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => oldChild?.exitCode).not.toBeNull()
    await launch()
    const afterHandoff = (await inspect()).durable_logs
    expect(afterHandoff.run_transfer_id).toBe(transfer)
    expect(output(afterHandoff)).toContain('DURABLE_RESTART_MARKER')
    const runtimePid = (await rpc(socket, { op: 'runtime.status' })).runtime_pid as number
    process.kill(runtimePid, 'SIGKILL')
    await expect.poll(async () => (await inspect()).execution_state).toBe('unavailable')
    const afterLoss = (await inspect()).durable_logs
    expect(afterLoss.run_transfer_id).toBe(transfer)
    expect(output(afterLoss)).toContain('DURABLE_RESTART_MARKER')
  } finally {
    if (servicePid && servicePid > 0) {
      try {
        process.kill(-servicePid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
    if (child && child.exitCode === null) {
      if (hello) await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id }).catch(() => undefined)
      child.kill()
    }
    if (child && child.exitCode === null) await new Promise((resolveExit) => child?.once('exit', resolveExit))
    await rm(root, { recursive: true, force: true })
  }
})

test('a redirected service log directory reports capture failure without writing outside the data directory', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (
      (await rpc(daemon.socket, { op: 'catalog.get' })).catalog as { workspaces: Array<{ id: string }> }
    ).workspaces[0]
    await symlink(daemon.rootDirectory, join(daemon.dataDirectory, 'service-logs'))
    await rpc(daemon.socket, {
      op: 'service.configure',
      workspace_id: workspace.id,
      name: 'redirected',
      revision: 0,
      config: {
        program: process.execPath,
        args: ['-e', 'console.log("CAPTURE_ERROR_MARKER"); setInterval(()=>{},1000)'],
        cwd: '.',
        env: {},
        ports: [],
      },
    })
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'redirected' })
    const inspect = (): Promise<Inspection & { logs: Durable }> =>
      rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'redirected' }) as Promise<
        Inspection & { logs: Durable }
      >
    await expect.poll(async () => output((await inspect()).logs)).toContain('CAPTURE_ERROR_MARKER')
    const result = (await inspect()).durable_logs as Durable & { capture_error?: string }
    expect(result.available).toBe(false)
    expect(result.capture_error).toContain('redirected')
    expect((await readdir(daemon.rootDirectory)).some((name) => /^[0-9a-f]{64}\.[01]$/.test(name))).toBe(false)
  } finally {
    await daemon.stop()
  }
})

test('replaced FIFO, oversized segment, and overflowing offset fail bounded inspection', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (
      (await rpc(daemon.socket, { op: 'catalog.get' })).catalog as { workspaces: Array<{ id: string }> }
    ).workspaces[0]
    await rpc(daemon.socket, {
      op: 'service.configure',
      workspace_id: workspace.id,
      name: 'unsafe-file',
      revision: 0,
      config: {
        program: process.execPath,
        args: ['-e', 'console.log("FILE_MARKER"); setInterval(()=>{},1000)'],
        cwd: '.',
        env: {},
        ports: [],
      },
    })
    const inspect = (): Promise<Inspection & { service: { terminal_id: string } }> =>
      rpc(daemon.socket, { op: 'service.inspect', workspace_id: workspace.id, name: 'unsafe-file' }) as Promise<
        Inspection & { service: { terminal_id: string } }
      >
    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'unsafe-file' })
    await expect.poll(async () => output((await inspect()).durable_logs)).toContain('FILE_MARKER')
    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'unsafe-file' })
    const terminalId = (await inspect()).service.terminal_id
    const key = createHash('sha256').update(`${workspace.id}\0${terminalId}`).digest('hex')
    const segment = join(daemon.dataDirectory, 'service-logs', `${key}.0`)
    const valid = await readFile(segment)
    await unlink(segment)
    const fifo = spawnSync('mkfifo', [segment])
    expect(fifo.status, fifo.stderr.toString()).toBe(0)
    const blocked = (await inspect()).durable_logs as Durable & { error?: string }
    expect(blocked).toMatchObject({ available: false, reason: 'log_unavailable' })
    expect(blocked.error).toContain('unsafe')
    await unlink(segment)
    await writeFile(segment, Buffer.alloc(48 + 512 * 1024 + 1), { mode: 0o600 })
    const oversized = (await inspect()).durable_logs as Durable & { error?: string }
    expect(oversized).toMatchObject({ available: false, reason: 'log_unavailable' })
    expect(oversized.error).toContain('exceeds its limit')
    valid.writeBigUInt64LE(2n ** 64n - 1n, 40)
    await writeFile(segment, valid, { mode: 0o600 })
    const overflowing = (await inspect()).durable_logs as Durable & { error?: string }
    expect(overflowing).toMatchObject({ available: false, reason: 'log_unavailable' })
    expect(overflowing.error).toContain('offset overflows')
  } finally {
    await daemon.stop()
  }
})
