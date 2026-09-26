import { expect, test } from '@playwright/test'
import { rpc, startDaemon } from '../fixtures/daemon'
import { setTimeout as delay } from 'node:timers/promises'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test('starts an isolated real daemon and reads its public catalog', async () => {
  const daemon = await startDaemon()
  try {
    expect(daemon.hello.application_protocol).toBe('ade-application-v1')
    expect(daemon.hello.runtime_protocol).toBe('ade-runtime-v8')
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    expect(catalog.type).toBe('catalog')
    expect(catalog.boot_id).toBe(daemon.hello.boot_id)
    expect(catalog.catalog).toBeTruthy()
  } finally {
    await daemon.stop()
  }
})

test('cleans up a detached runtime when daemon startup fails after the runtime starts', async () => {
  const external = await mkdtemp(join(tmpdir(), 'ade-e2e-external-data-'))
  const dataDirectory = join(external, 'data')
  await mkdir(dataDirectory)
  let runtimePid = 0
  let runtimeSocket = ''
  let runtimeInstance = ''
  try {
    const startError = await startDaemon({ ADE_DATA_DIR: dataDirectory }, (hello) => {
      runtimePid = Number(hello.runtime_pid)
      runtimeSocket = String(hello.runtime_socket)
      runtimeInstance = String(hello.runtime_instance)
      throw new Error('Injected fixture startup failure after runtime launch')
    }).then(() => null, (error: unknown) => error)
    expect(String(startError)).toContain('Injected fixture startup failure')
    expect(runtimePid).toBeGreaterThan(0)
    await expect.poll(async () => {
      try { process.kill(runtimePid, 0); return true } catch { return false }
    }, { timeout: 2_000 }).toBe(false)
    await expect(rpc(runtimeSocket, { op: 'hello' })).rejects.toThrow()
    await expect(access(dirname(runtimeSocket))).rejects.toThrow()
    await expect(access(dataDirectory)).resolves.toBeUndefined()
  } finally {
    if (runtimeSocket) {
      const live = await rpc(runtimeSocket, { op: 'hello' }).catch(() => null)
      if (live?.instance_id === runtimeInstance) {
        await rpc(runtimeSocket, { op: 'runtime.stop', instance_id: runtimeInstance, stop_active: true })
      }
    }
    let alive = false
    if (runtimePid > 0) {
      try { process.kill(runtimePid, 0); alive = true } catch { /* The runtime exited. */ }
    }
    if (!alive) await rm(external, { recursive: true, force: true })
  }
})

test('stops its detached runtime after the daemon exits unexpectedly', async () => {
  const daemon = await startDaemon()
  const daemonPid = Number(daemon.hello.pid)
  const runtimePid = Number(daemon.hello.runtime_pid)
  const runtimeSocket = String(daemon.hello.runtime_socket)
  const runtimeInstance = String(daemon.hello.runtime_instance)

  try {
    process.kill(daemonPid, 'SIGKILL')
    await expect.poll(async () => {
      try { process.kill(daemonPid, 0); return true } catch { return false }
    }).toBe(false)
    await daemon.stop()
    await expect(access(daemon.rootDirectory)).rejects.toThrow()
    await expect.poll(async () => {
      try { process.kill(runtimePid, 0); return true } catch { return false }
    }, { timeout: 2_000 }).toBe(false)
    await expect(rpc(runtimeSocket, { op: 'hello' })).rejects.toThrow()
  } finally {
    const live = await rpc(runtimeSocket, { op: 'hello' }).catch(() => null)
    if (live?.instance_id === runtimeInstance) {
      await rpc(runtimeSocket, { op: 'runtime.stop', instance_id: runtimeInstance, stop_active: true })
      await delay(100)
    }
  }
})
