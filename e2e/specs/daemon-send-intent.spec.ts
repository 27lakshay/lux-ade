import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, startDaemon } from '../fixtures/daemon'

test('a durable send intent survives lost acknowledgement and daemon restart without duplicate dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-send-intent-e2e-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  const mockDirectory = join(root, 'codex')
  await mkdir(dataDirectory)
  let child: ChildProcess | null = null
  let hello: Record<string, unknown> | null = null
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], {
      env: { ...process.env, ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root,
        ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
        ADE_MOCK_DIR: mockDirectory, SHELL: '/bin/sh' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* The daemon has not bound the socket yet. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  const stop = async (): Promise<void> => {
    if (!child || !hello) return
    const stopping = child
    const instance = hello.runtime_instance
    const runtimeSocket = hello.runtime_socket
    await expect.poll(async () => {
      try { return (await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })).type }
      catch { return 'busy' }
    }, { timeout: 10_000 }).toBe('ack')
    await expect.poll(() => stopping.exitCode, { timeout: 10_000 }).not.toBeNull()
    if (typeof runtimeSocket === 'string') {
      await rpc(runtimeSocket, { op: 'runtime.stop', instance_id: instance, stop_active: true })
    }
    child = null
    hello = null
  }
  const restart = async (): Promise<void> => {
    if (!child || !hello) throw new Error('Daemon was not started')
    const stopping = child
    await expect.poll(async () => {
      try { return (await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })).type }
      catch { return 'busy' }
    }, { timeout: 10_000 }).toBe('ack')
    await expect.poll(() => stopping.exitCode, { timeout: 10_000 }).not.toBeNull()
    await launch()
  }
  try {
    await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const conversation = (await rpc(socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    const owner = { conversation_id: conversation.id, window_id: 'window-restart' }
    const raw = '  typed-tool  '
    const text = raw.trim()
    await rpc(socket, { op: 'draft.save', ...owner, text: raw, revision: 1 })
    const prepare = { op: 'draft.send.prepare', ...owner, request_id: 'send-1', draft_text: raw,
      text, revision: 1 }
    const intent = await rpc(socket, prepare)
    expect(intent).toMatchObject({ type: 'send_intent', intent: { request_id: 'send-1',
      draft_text: raw, text, state: 'pending' } })
    expect(await rpc(socket, prepare)).toEqual(intent)
    await expect(rpc(socket, { ...prepare, text: 'another prompt' })).rejects.toThrow('different prompt')
    await expect(rpc(socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'send-1', text: 'another prompt' })).rejects.toThrow('different prompt')
    await expect(rpc(socket, { ...prepare, request_id: 'send-2' })).rejects.toThrow('pending send')
    await expect(rpc(socket, { op: 'draft.save', ...owner, text: 'changed', revision: 2 })).rejects.toThrow('pending send')

    // Destroy the client socket as soon as the command is sent. The daemon can
    // accept it and dispatch the provider turn without delivering its reply.
    await new Promise<void>((resolveSent, rejectSent) => {
      const peer = createConnection(socket)
      peer.once('error', rejectSent)
      peer.once('connect', () => {
        peer.write(`${JSON.stringify({ op: 'agent.send', conversation_id: conversation.id,
          request_id: 'send-1', text })}\n`, () => { peer.destroy(); resolveSent() })
      })
    })
    await expect.poll(async () => {
      const snapshot = await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id })
      return (snapshot.messages as Array<{ id: string }>).some((item) => item.id === 'send-1')
    }).toBe(true)
    await restart()
    expect(await rpc(socket, { op: 'draft.send.get', ...owner })).toMatchObject({
      intent: { request_id: 'send-1', draft_text: raw, text, state: 'pending' },
    })
    await rpc(socket, { op: 'agent.send', conversation_id: conversation.id, request_id: 'send-1', text })
    expect(await rpc(socket, { op: 'draft.send.complete', ...owner, request_id: 'send-1' })).toMatchObject({
      draft: { text: '', revision: 2 },
    })
    expect(await rpc(socket, { op: 'draft.send.get', ...owner })).toMatchObject({ intent: null })
    expect(await rpc(socket, prepare)).toMatchObject({ intent: { request_id: 'send-1', state: 'completed' } })
    await rpc(socket, { op: 'draft.save', ...owner, text: 'later draft', revision: 3 })
    expect(await rpc(socket, { op: 'draft.send.complete', ...owner, request_id: 'send-1' })).toMatchObject({
      draft: { text: '', revision: 2 },
    })
    expect(await rpc(socket, { op: 'draft.get', ...owner })).toMatchObject({ draft: { text: 'later draft', revision: 3 } })
    await expect(rpc(socket, { ...prepare, text: 'another prompt' })).rejects.toThrow('different prompt')
    await expect(rpc(socket, { op: 'draft.send.abort', ...owner, request_id: 'send-1' })).rejects.toThrow('not a confirmed')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.map((line) => JSON.parse(line) as { method: string }).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    if (child && hello) await stop().catch(() => child?.kill())
    else child?.kill()
    await rm(root, { recursive: true, force: true })
  }
})

test('a confirmed pre-admission rejection can be aborted without losing the draft', async () => {
  const mockDirectory = await mkdtemp(join(tmpdir(), 'ade-send-rejection-mock-'))
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'first', text: 'approval' })
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'legacy-owner', text: 'approval', revision: 1 })
    await expect(rpc(daemon.socket, { op: 'draft.send.prepare', conversation_id: conversation.id,
      window_id: 'legacy-owner', request_id: 'first', draft_text: 'approval',
      text: 'approval', revision: 1 })).rejects.toThrow('already accepted as a message')
    await expect.poll(async () => {
      const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
      return (snapshot.requests as Array<unknown>).length
    }).toBe(1)
    const owner = { conversation_id: conversation.id, window_id: 'second-window' }
    await rpc(daemon.socket, { op: 'draft.save', ...owner, text: 'next', revision: 1 })
    await rpc(daemon.socket, { op: 'draft.send.prepare', ...owner, request_id: 'second',
      draft_text: 'next', text: 'next', revision: 1 })
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'second', text: 'next' })).rejects.toThrow('active turn')
    expect(await rpc(daemon.socket, { op: 'draft.send.get', ...owner })).toMatchObject({
      intent: { request_id: 'second', state: 'rejected' },
    })
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'second', text: 'next' })).rejects.toThrow('rejected before admission')
    await expect(rpc(daemon.socket, { op: 'draft.send.complete', ...owner,
      request_id: 'second' })).rejects.toThrow('not been accepted')
    await rpc(daemon.socket, { op: 'draft.send.abort', ...owner, request_id: 'second' })
    await rpc(daemon.socket, { op: 'draft.send.abort', ...owner, request_id: 'second' })
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'second', text: 'next' })).rejects.toThrow('was aborted')
    await rpc(daemon.socket, { op: 'draft.save', ...owner, text: 'next edited', revision: 2 })
    expect(await rpc(daemon.socket, { op: 'draft.get', ...owner })).toMatchObject({
      draft: { text: 'next edited', revision: 2 },
    })
    await expect(rpc(daemon.socket, { op: 'draft.send.prepare', ...owner, request_id: 'second',
      draft_text: 'next edited', text: 'next edited', revision: 2 })).rejects.toThrow('different prompt')
  } finally {
    await daemon.stop()
    await rm(mockDirectory, { recursive: true, force: true })
  }
})
