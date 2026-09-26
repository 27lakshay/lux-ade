import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function runCli(socket: string, ...args: string[]): Promise<{ code: number; output: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 20_000 })
    return { code: 0, output: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, output: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('CLI exports all paginated native history as a readable, lossless file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-history-export-e2e-'))
  const mockDirectory = join(directory, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', title: 'History to export' })).conversation as { id: string }
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'export-first', text: 'First prompt' })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'conversation.get',
      conversation_id: conversation.id })).conversation as { status: string }).toMatchObject({ status: 'ready' })
    await rpc(daemon.socket, { op: 'agent.disconnect', conversation_id: conversation.id })

    const threadFile = (await readdir(mockDirectory)).find((name) => name.endsWith('.json'))
    if (!threadFile) throw new Error('Codex fixture did not write native history')
    const filename = join(mockDirectory, threadFile)
    const thread = JSON.parse(await readFile(filename, 'utf8')) as { turns: unknown[] }
    for (let index = 0; index < 110; index++) {
      thread.turns.push({ id: `export-turn-${index}`, status: 'completed', items: [
        { id: `export-user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${index}` }] },
        { id: `export-answer-${index}`, type: 'agentMessage', text: `Answer ${index}` },
      ] })
    }
    await writeFile(filename, JSON.stringify(thread))
    await rpc(daemon.socket, { op: 'agent.resume', conversation_id: conversation.id })
    await expect.poll(async () => {
      const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
      return ((snapshot.messages as Array<{ sequence: number }>).at(-1)?.sequence ?? 0)
    }).toBeGreaterThan(200)

    const destination = join(directory, 'history.json')
    const result = await runCli(daemon.socket, 'conversation', 'export', conversation.id, destination)
    expect(result).toMatchObject({ code: 0, output: { type: 'conversation_export',
      conversation_id: conversation.id, format: 'ade-conversation-history-v1' } })
    const archive = JSON.parse(await readFile(destination, 'utf8')) as {
      scope: string; conversation: { id: string }; messages: Array<{ id: string; sequence: number; text: string }>
    }
    expect(archive.scope).toBe('conversation-history')
    expect(archive.conversation.id).toBe(conversation.id)
    expect(archive.messages.length).toBeGreaterThan(200)
    expect(result.output.message_count).toBe(archive.messages.length)
    expect(archive.messages.map((message) => message.sequence)).toEqual(
      [...archive.messages.map((message) => message.sequence)].sort((a, b) => b - a))
    expect(archive.messages.map((message) => message.text).join('\n')).toContain('First prompt')
    expect(archive.messages.map((message) => message.text).join('\n')).toContain('Answer 109')
    expect(new Set(archive.messages.map((message) => message.id)).size).toBe(archive.messages.length)
    const expected: Array<Record<string, unknown>> = []
    let before: number | undefined
    for (;;) {
      const page = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id,
        limit: 100, ...(before === undefined ? {} : { before }) })
      const messages = page.messages as Array<Record<string, unknown> & { sequence: number }>
      expected.push(...[...messages].reverse())
      if (messages.length < 100) break
      before = messages[0].sequence
    }
    expect(archive.messages).toEqual(expected)

    const collision = await runCli(daemon.socket, 'conversation', 'export', conversation.id, destination)
    expect(collision).toMatchObject({ code: 2, output: { type: 'error', code: 'invalid_request' } })
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual(archive)
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI refuses a changed later page without publishing a partial export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-history-page-e2e-'))
  const daemon = await startDaemon()
  const proxySocket = join(directory, 'history.sock')
  const peers = new Set<Socket>()
  let pageNumber = 0
  let conversationId = ''
  const proxy = createServer((downstream) => {
    const upstream = createConnection(daemon.socket)
    peers.add(downstream)
    peers.add(upstream)
    let requests = ''
    let replies = ''
    let operation = ''
    downstream.on('data', (chunk: Buffer) => {
      requests += chunk.toString('utf8')
      for (;;) {
        const end = requests.indexOf('\n')
        if (end < 0) break
        const line = requests.slice(0, end + 1)
        requests = requests.slice(end + 1)
        operation = (JSON.parse(line) as { op: string }).op
        upstream.write(line)
      }
    })
    upstream.on('data', (chunk: Buffer) => {
      replies += chunk.toString('utf8')
      for (;;) {
        const end = replies.indexOf('\n')
        if (end < 0) break
        const line = replies.slice(0, end)
        replies = replies.slice(end + 1)
        const response = JSON.parse(line) as Record<string, unknown>
        if (operation === 'conversation.get' && response.type === 'conversation_snapshot') {
          if (pageNumber++ === 0) {
            response.messages = Array.from({ length: 100 }, (_, index) => ({
              id: `injected-${index}`, conversation_id: conversationId, sequence: index + 1,
              role: 'user', kind: 'text', text: `injected ${index}`, status: 'complete',
            }))
          } else {
            response.revision = (response.revision as number) + 1
          }
        }
        downstream.write(`${JSON.stringify(response)}\n`)
      }
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy() })
  })
  await new Promise<void>((resolveListen) => proxy.listen(proxySocket, resolveListen))
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', title: 'Reject corrupted page' })).conversation as { id: string }
    conversationId = conversation.id
    const destination = join(directory, 'must-not-exist.json')
    const failed = await runCli(proxySocket, 'conversation', 'export', conversation.id, destination)
    expect(failed).toMatchObject({ code: 6, output: { type: 'error', code: 'protocol' } })
    expect(String(failed.output.message)).toMatch(/Conversation changed or daemon returned an invalid history page/)
    expect(pageNumber).toBe(2)
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(directory)).filter((name) => name.includes('.tmp'))).toEqual([])
  } finally {
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
