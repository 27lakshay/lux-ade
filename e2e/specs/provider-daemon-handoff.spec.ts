import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { managedProfileOwner, rpc, stopManagedProfile, stopOrphanRuntime,
  type ManagedProfileOwner } from '../fixtures/daemon'

test('a provider tool and native session survive a compatible daemon handoff without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-provider-handoff-e2e-'))
  const data = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  const mock = join(root, 'codex')
  await mkdir(data)
  let child: ChildProcess | null = null
  let owner: ManagedProfileOwner | null = null
  let stopped = false
  const launch = async (): Promise<ManagedProfileOwner> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: {
      ...process.env, ADE_DATA_DIR: data, ADE_SOCKET: socket, ADE_ROOT: root,
      ADE_RUNTIME_SOCKET: join(root, 'runtime.sock'), SHELL: '/bin/sh',
      ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
      ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mock,
    }, stdio: ['ignore', 'ignore', 'pipe'] })
    // The replacement is not owned until it reports its identity. On startup
    // failure, kill only this spawned child before locating its test runtime.
    owner = null
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') {
          owner = await managedProfileOwner(socket)
          return owner
        }
      } catch { /* Wait for the socket to become ready. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  try {
    owner = await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const conversation = (await rpc(socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    await rpc(socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'provider-handoff-turn', text: 'handoff-tool' })
    await expect.poll(async () => (await readFile(join(mock, 'calls.jsonl'), 'utf8').catch(() => ''))
      .includes('"method": "fixture/tool"')).toBe(true)
    const callsBefore = (await readFile(join(mock, 'calls.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; tool_pid?: number })
    const toolPid = callsBefore.find((call) => call.method === 'fixture/tool')?.tool_pid
    expect(toolPid).toBeGreaterThan(0)
    const nativeThread = (await rpc(socket, { op: 'conversation.get',
      conversation_id: conversation.id })).conversation.provider_thread_id
    expect(nativeThread).toBeTruthy()
    const runtimeInstance = owner.runtimeInstance
    const previousBoot = owner.bootId
    const previousChild = child
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: previousBoot })
    await expect.poll(() => previousChild?.exitCode, { timeout: 10_000 }).not.toBeNull()
    child = null
    owner = await launch()
    expect(owner.bootId).not.toBe(previousBoot)
    expect(owner.runtimeInstance).toBe(runtimeInstance)
    expect(() => process.kill(toolPid!, 0)).not.toThrow()
    await writeFile(join(mock, 'release-tool'), '')
    await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
      conversation_id: conversation.id })).conversation.status, { timeout: 15_000 }).toBe('ready')
    const snapshot = await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id })
    expect(snapshot.conversation.provider_thread_id).toBe(nativeThread)
    expect((snapshot.messages as Array<{ role: string; text: string }>).filter((message) =>
      message.text?.includes('tool completed once'))).toHaveLength(1)
    const calls = (await readFile(join(mock, 'calls.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string })
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    await writeFile(join(mock, 'release-tool'), '').catch(() => undefined)
    try {
      if (owner) await stopManagedProfile(owner)
      else {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise((done) => child?.once('exit', done))
        }
        await stopOrphanRuntime(data)
      }
      stopped = true
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((done) => child?.once('exit', done))
      }
      if (stopped) await rm(root, { recursive: true, force: true })
    }
  }
})
