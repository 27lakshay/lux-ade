import { expect, test } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfile, stopOrphanRuntime,
  type ManagedProfileOwner } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function send(socket: string, conversation: string, text: string, requestId: string) {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket,
      'conversation', 'send', conversation, text, '--request-id', requestId], { timeout: 12_000 })
    return { code: 0, output: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw error
    return { code: failure.code, output: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('CLI caller-owned send ID survives lost reply and daemon handoff without retargeting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-cli-retry-e2e-'))
  const data = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  const proxySocket = join(root, 'drop-reply.sock')
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
    owner = null
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') {
          owner = await managedProfileOwner(socket)
          return owner
        }
      } catch { /* Wait for the socket. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  const peers = new Set<Socket>()
  let dropped = false
  const proxy = createServer((client) => {
    const upstream = createConnection(socket)
    peers.add(client)
    peers.add(upstream)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => { peers.delete(client); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); client.destroy() })
    client.on('data', (chunk) => upstream.write(chunk))
    let pending = ''
    upstream.setEncoding('utf8')
    upstream.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const end = pending.indexOf('\n')
        if (end < 0) break
        const frame = pending.slice(0, end + 1)
        pending = pending.slice(end + 1)
        const response = JSON.parse(frame) as { type: string }
        if (response.type === 'ack') {
          dropped = true
          client.destroy()
          upstream.destroy()
          return
        }
        client.write(frame)
      }
    })
  })
  try {
    owner = await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const first = (await rpc(socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    const second = (await rpc(socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    await new Promise<void>((resolveListen, rejectListen) => {
      proxy.once('error', rejectListen)
      proxy.listen(proxySocket, resolveListen)
    })
    const requestId = 'cli-owned-lost-reply'
    const text = 'hello once'
    const lost = await send(proxySocket, first.id, text, requestId)
    expect(dropped).toBe(true)
    expect(lost).toMatchObject({ code: 3, output: { type: 'error', code: 'unavailable' } })
    await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
      conversation_id: first.id })).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requestId, role: 'user', text }),
    ]))
    const previousBoot = owner.bootId
    const runtimeInstance = owner.runtimeInstance
    const previousChild = child
    await expect.poll(async () => {
      try { return (await rpc(socket, { op: 'runtime.prepare_restart', boot_id: previousBoot })).type }
      catch (error) {
        if (String(error).includes('still being admitted')) return 'busy'
        throw error
      }
    }, { timeout: 10_000 }).toBe('ack')
    await expect.poll(() => previousChild?.exitCode, { timeout: 10_000 }).not.toBeNull()
    child = null
    owner = await launch()
    expect(owner.bootId).not.toBe(previousBoot)
    expect(owner.runtimeInstance).toBe(runtimeInstance)
    const retried = await send(socket, first.id, text, requestId)
    expect(retried).toEqual({ code: 0, output: { type: 'ack', request_id: requestId } })
    const conflict = await send(socket, first.id, 'altered text', requestId)
    expect(conflict).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })
    expect(String(conflict.output.message)).toMatch(/different|conflict|already/i)
    const wrongTarget = await send(socket, second.id, text, requestId)
    expect(wrongTarget).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })
    const secondSnapshot = await rpc(socket, { op: 'conversation.get', conversation_id: second.id })
    expect(secondSnapshot.messages).toEqual([])
    await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
      conversation_id: first.id })).conversation.status, { timeout: 15_000 }).toBe('ready')
    const calls = (await readFile(join(mock, 'calls.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string })
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    for (const peer of peers) peer.destroy()
    if (proxy.listening) await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
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
