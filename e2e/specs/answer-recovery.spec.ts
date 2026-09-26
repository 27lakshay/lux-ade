import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { rpc, startDaemon, stopManagedProfile, stopOrphanRuntime } from '../fixtures/daemon'

const crashScenarios: Array<{ failpoint: string; expire: boolean; fault?: boolean }> = [
  { failpoint: 'before_delivery', expire: false },
  { failpoint: 'after_delivery', expire: false },
  { failpoint: 'before_delivery', expire: true },
  { failpoint: 'after_not_sent_receipt', expire: true, fault: true },
  { failpoint: 'after_not_sent_receipt', expire: false, fault: true },
  { failpoint: 'after_attempt_advance', expire: false, fault: true },
]
for (const scenario of crashScenarios) {
  test(`${scenario.expire ? `native resolution cannot fake an answer receipt after ${scenario.failpoint}` :
    `answer retry reconciles daemon death ${scenario.failpoint} without a second native reply`}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ade-answer-recovery-'))
    const data = join(root, 'data')
    const socket = join(root, 'daemon.sock')
    const mock = join(root, 'codex')
    await mkdir(data)
    let child: ChildProcess | null = null
    let hello: Record<string, unknown> | null = null
    const launch = async (point?: string, fault = false): Promise<void> => {
      child = spawn(resolve('target/debug/ade-daemon'), [], {
        env: { ...process.env, ADE_DATA_DIR: data, ADE_SOCKET: socket, ADE_ROOT: root,
          ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'), ADE_CODEX_TRANSPORT: 'stdio',
          ADE_MOCK_DIR: mock, SHELL: '/bin/sh',
          ...(fault ? { ADE_E2E_ANSWER_FAULT: 'before_native' } : {}),
          ...(point ? { ADE_E2E_ANSWER_FAILPOINT: point } : {}) },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      child.stderr?.resume()
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          hello = await rpc(socket, { op: 'hello' })
          if (hello.type === 'hello') return
        } catch { /* Wait for the owned daemon socket. */ }
        if (child.exitCode !== null) throw new Error(`Daemon exited at startup: ${child.exitCode}`)
        await delay(50)
      }
      throw new Error('Daemon did not start')
    }
    try {
      await launch(scenario.failpoint, scenario.fault)
      const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
      const conversation = (await rpc(socket, { op: 'conversation.create', workspace_id: workspace.id,
        provider: 'codex', title: 'Answer recovery' })).conversation as { id: string }
      await rpc(socket, { op: 'agent.send', conversation_id: conversation.id,
        request_id: 'answer-turn', text: scenario.expire ? 'approval-expire' : 'approval' })
      let requestId = ''
      await expect.poll(async () => {
        const snapshot = await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id })
        const requests = snapshot.requests as Array<{ id: string; status: string }>
        requestId = requests.find((item) => item.status === 'pending')?.id ?? ''
        return requestId
      }).not.toBe('')

      const answer = { op: 'agent.answer', conversation_id: conversation.id,
        request_id: requestId, decision: 'decline' }
      if (scenario.failpoint === 'after_delivery' && !scenario.expire) {
        const client = await import(pathToFileURL(resolve('packages/client/dist/index.js')).href)
        await expect(client.dailyUseCommand(socket, answer)).rejects.toMatchObject({ delivery: 'unknown' })
      } else {
        await expect(rpc(socket, answer)).rejects.toThrow()
      }
      await expect.poll(() => child?.exitCode).toBe(94)
      if (scenario.expire) await writeFile(join(mock, 'expire-approval'), '')
      await launch()
      await expect(rpc(socket, { ...answer, decision: 'accept' }))
        .rejects.toThrow('Answer conflicts with the recorded decision')
      if (scenario.expire) {
        await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
          conversation_id: conversation.id })).conversation).toMatchObject({ status: 'ready' })
        await expect(rpc(socket, answer)).rejects.toThrow(scenario.fault
          ? 'Native request ended before ADE delivered this answer'
          : 'without a recorded answer receipt')
      } else {
        if (scenario.failpoint === 'after_not_sent_receipt') {
          await expect(rpc(socket, answer)).rejects.toThrow('Answer was not sent to the provider')
        }
        expect(await rpc(socket, answer)).toMatchObject({ type: 'ack' })
        expect(await rpc(socket, answer)).toMatchObject({ type: 'ack' })
      }
      await expect.poll(async () => {
        const calls = (await readFile(join(mock, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
        return calls.filter((line) => JSON.parse(line).method === 'approval/reply').length
      }).toBe(scenario.expire ? 0 : 1)
      await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
        conversation_id: conversation.id })).conversation).toMatchObject({ status: 'ready' })
      if (scenario.fault) {
        const settled = await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id })
        expect((settled.conversation as { error: string | null }).error).toBeNull()
      }
    } finally {
      const owner = hello
      if (owner && typeof owner.boot_id === 'string' && typeof owner.pid === 'number' &&
        typeof owner.runtime_socket === 'string' && typeof owner.runtime_instance === 'string' &&
        typeof owner.runtime_pid === 'number') {
        await stopManagedProfile({ socket, bootId: owner.boot_id, daemonPid: owner.pid,
          runtimeSocket: owner.runtime_socket, runtimeInstance: owner.runtime_instance,
          runtimePid: owner.runtime_pid })
      } else {
        if (child && child.exitCode === null) child.kill('SIGKILL')
        await stopOrphanRuntime(data)
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('a proven pre-native failure permits one safe retry of the same answer', async () => {
  const mock = await mkdtemp(join(tmpdir(), 'ade-answer-fault-'))
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mock,
    ADE_E2E_ANSWER_FAULT: 'before_native',
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', title: 'Failed answer' })).conversation as { id: string }
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'fault-turn', text: 'approval' })
    let id = ''
    await expect.poll(async () => {
      const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
      id = (snapshot.requests as Array<{ id: string }>)[0]?.id ?? ''
      return id
    }).not.toBe('')
    const answer = { op: 'agent.answer', conversation_id: conversation.id,
      request_id: id, decision: 'decline' }
    await expect(rpc(daemon.socket, answer)).rejects.toThrow('Answer was not sent to the provider')
    await expect(rpc(daemon.socket, { ...answer, decision: 'accept' }))
      .rejects.toThrow('Answer conflicts with the recorded decision')
    const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
    expect(snapshot.conversation).toMatchObject({ status: 'waiting' })
    expect(snapshot.requests).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: 'pending', answer_attempt: 1 })]))
    expect(await rpc(daemon.socket, answer)).toMatchObject({ type: 'ack' })
    expect(await rpc(daemon.socket, answer)).toMatchObject({ type: 'ack' })
    await expect.poll(async () => (await readFile(join(mock, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .filter((line) => JSON.parse(line).method === 'approval/reply').length).toBe(1)
    const settled = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
    expect((settled.conversation as { error: string | null }).error).toBeNull()
  } finally {
    await daemon.stop()
    await rm(mock, { recursive: true, force: true })
  }
})

test('concurrent conflicting answers admit one decision and one native reply', async () => {
  const mock = await mkdtemp(join(tmpdir(), 'ade-answer-race-'))
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mock,
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', title: 'Answer race' })).conversation as { id: string }
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'race-turn', text: 'approval' })
    let id = ''
    await expect.poll(async () => {
      const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
      id = (snapshot.requests as Array<{ id: string }>)[0]?.id ?? ''
      return id
    }).not.toBe('')
    const base = { op: 'agent.answer', conversation_id: conversation.id, request_id: id }
    const attempts = await Promise.allSettled([
      rpc(daemon.socket, { ...base, decision: 'accept' }),
      rpc(daemon.socket, { ...base, decision: 'decline' }),
    ])
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect(String((attempts.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('Answer conflicts with the recorded decision')
    const winner = attempts[0].status === 'fulfilled' ? 'accept' : 'decline'
    expect(await rpc(daemon.socket, { ...base, decision: winner })).toMatchObject({ type: 'ack' })
    await expect.poll(async () => (await readFile(join(mock, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .filter((line) => JSON.parse(line).method === 'approval/reply').length).toBe(1)
  } finally {
    await daemon.stop()
    await rm(mock, { recursive: true, force: true })
  }
})
