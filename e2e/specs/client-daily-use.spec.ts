import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startDaemon } from '../fixtures/daemon'

const desktop = resolve('apps/desktop')
const executable = createRequire(join(desktop, 'package.json'))('electron') as string

test('headless client uses generated contracts to control a GUI-created conversation', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-client-daily-use-'))
  const mock = join(userData, 'codex')
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mock })
  const application = await electron.launch({ executablePath: executable, args: [desktop],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1' } })
  const clientPackage = await import(pathToFileURL(resolve('packages/client/dist/index.js')).href)
  const client = new clientPackage.AdeClient(daemon.socket)
  const feed: Array<{ type: string; revision: number }> = []
  const unsubscribe = client.subscribeDailyUseFeed((frame) => feed.push({ type: frame.type, revision: frame.revision }))
  client.start()
  const proxy = createServer((downstream) => {
    const upstream = createConnection(daemon.socket)
    downstream.on('data', (chunk) => upstream.write(chunk))
    downstream.on('error', () => upstream.destroy())
    downstream.on('close', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    let buffered = ''
    upstream.setEncoding('utf8')
    upstream.on('data', (chunk: string) => {
      buffered += chunk
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        const frame = JSON.parse(buffered.slice(0, newline)) as { type: string }
        buffered = buffered.slice(newline + 1)
        if (frame.type === 'ack') downstream.end('{"type":"wrong_reply"}\n')
        else downstream.write(`${JSON.stringify(frame)}\n`)
      }
    })
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect.poll(() => client.getState().status).toBe('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const catalog = await client.getCatalog()
    expect(catalog.type).toBe('catalog')
    expect(catalog.catalog.conversations).toHaveLength(1)
    const conversationId = catalog.catalog.conversations[0].id
    await expect.poll(() => feed.some((frame) => frame.type === 'catalog')).toBe(true)

    expect((await client.sendPrompt(conversationId, 'sdk-send-one', 'hello once')).type).toBe('ack')
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-assistant'))
      .toContainText('Hello world')
    const snapshot = await client.getConversation(conversationId)
    await expect.poll(() => feed.some((frame) => frame.type === 'conversation_changed')).toBe(true)
    expect(snapshot.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sdk-send-one', role: 'user', text: 'hello once' }),
    ]))
    expect((await client.sendPrompt(conversationId, 'sdk-send-one', 'hello once')).type).toBe('ack')
    await expect(client.sendPrompt(conversationId, 'sdk-send-one', 'different text'))
      .rejects.toMatchObject({ code: 'daemon', delivery: 'unknown' })
    const calls = (await readFile(join(mock, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)

    await client.sendPrompt(conversationId, 'sdk-approval', 'approval')
    await expect(window.getByRole('region', { name: 'Pending approval' })).toContainText('echo fixture')
    const pending = await client.getConversation(conversationId)
    expect(pending.requests).toHaveLength(1)
    expect((await client.answerRequest(conversationId, pending.requests[0].id, 'decline')).type).toBe('ack')
    await expect(window.getByRole('region', { name: 'Pending approval' })).toHaveCount(0)
    await expect.poll(() => feed.filter((frame) => frame.type === 'conversation_changed').length).toBeGreaterThan(1)
    await expect.poll(async () => (await client.getConversation(conversationId)).conversation.status).toBe('ready')

    const proxySocket = join(userData, 'reply-corruption.sock')
    await new Promise<void>((done) => proxy.listen(proxySocket, done))
    await expect(clientPackage.dailyUseCommand(proxySocket, { op: 'agent.send',
      conversation_id: conversationId, request_id: 'sdk-corrupt-reply', text: 'hello after bad ack' }))
      .rejects.toMatchObject({ code: 'protocol', delivery: 'unknown' })
    expect((await client.sendPrompt(conversationId, 'sdk-corrupt-reply', 'hello after bad ack')).type).toBe('ack')
    await expect.poll(async () => (await client.getConversation(conversationId)).messages
      .filter((message) => message.id === 'sdk-corrupt-reply').length).toBe(1)
  } finally {
    if (proxy.listening) await new Promise<void>((done) => proxy.close(() => done()))
    unsubscribe()
    client.stop()
    await application.close().catch(() => undefined)
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
