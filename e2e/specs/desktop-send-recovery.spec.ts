import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('a dropped send reply keeps one prompt across retry and renderer reload', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-send-recovery-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const proxySocket = join(userData, 'proxy.sock')
  let dropSendReply = true
  let blockSnapshots = false
  const peers = new Set<Socket>()
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
        const request = JSON.parse(line) as { op: string }
        operation = request.op
        if ((request.op === 'conversation.get' || request.op === 'draft.send.complete') && blockSnapshots) {
          downstream.destroy()
          upstream.destroy()
          break
        }
        upstream.write(line)
      }
    })
    upstream.on('data', (chunk: Buffer) => {
      replies += chunk.toString('utf8')
      for (;;) {
        const end = replies.indexOf('\n')
        if (end < 0) break
        const line = replies.slice(0, end + 1)
        replies = replies.slice(end + 1)
        const response = JSON.parse(line) as { type: string }
        if (operation === 'agent.send' && response.type === 'ack' && dropSendReply) {
          dropSendReply = false
          blockSnapshots = true
          downstream.destroy()
          upstream.destroy()
          break
        }
        downstream.write(line)
      }
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy() })
  })
  await new Promise<void>((resolveListen) => proxy.listen(proxySocket, resolveListen))
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await prompt.fill('typed-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.getByText('Prompt delivery is unconfirmed.', { exact: false })).toBeVisible()
    await expect(prompt).toBeDisabled()
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(conversation.getByText('Prompt delivery is unconfirmed.', { exact: false })).toBeVisible()
    await expect(prompt).toHaveValue('typed-tool')
    blockSnapshots = false
    await conversation.getByRole('button', { name: 'Retry prompt delivery' }).click()
    await expect(prompt).toHaveValue('')
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
  } finally {
    await application.close()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('a daemon-rejected prompt does not trap the draft or window', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-send-rejected-'))
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: join(userData, 'codex'),
  })
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    await expect(window.getByRole('region', { name: 'Conversation' })).toBeVisible()
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const conversationId = (catalog.catalog as { conversations: Array<{ id: string }> }).conversations[0].id
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversationId,
      request_id: 'active-turn', text: 'hold' })
    await window.evaluate((id) => window.adeHost.requestConversation('draft.save', {
      conversation_id: id, text: 'rejected prompt',
    }), conversationId)
    const error = await window.evaluate(async (id) => {
      try {
        await window.adeHost.requestConversation('agent.send', {
          conversation_id: id, request_id: crypto.randomUUID(), text: 'rejected prompt',
        })
        return ''
      } catch (reason) { return String(reason) }
    }, conversationId)
    expect(error).toContain('active turn')
    const draft = await window.evaluate((id) => window.adeHost.requestConversation('draft.get', { conversation_id: id }), conversationId)
    expect(draft.send_pending).toBeNull()
    await window.evaluate((id) => window.adeHost.requestConversation('draft.save', {
      conversation_id: id, text: 'editable after rejection',
    }), conversationId)
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('a crashed Electron process recovers its send ID and does not dispatch a second provider turn', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-process-send-recovery-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory,
  })
  const proxySocket = join(userData, 'proxy.sock')
  let dropSendReply = true
  let blockComplete = true
  const peers = new Set<Socket>()
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
        if (operation === 'draft.send.complete' && blockComplete) {
          downstream.destroy()
          upstream.destroy()
          break
        }
        upstream.write(line)
      }
    })
    upstream.on('data', (chunk: Buffer) => {
      replies += chunk.toString('utf8')
      for (;;) {
        const end = replies.indexOf('\n')
        if (end < 0) break
        const line = replies.slice(0, end + 1)
        replies = replies.slice(end + 1)
        const response = JSON.parse(line) as { type: string }
        if (operation === 'agent.send' && response.type === 'ack' && dropSendReply) {
          dropSendReply = false
          downstream.destroy()
          upstream.destroy()
          break
        }
        downstream.write(line)
      }
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy() })
  })
  await new Promise<void>((resolveListen) => proxy.listen(proxySocket, resolveListen))
  const launch = () => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData } })
  let application = await launch()
  try {
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await prompt.fill('  typed-tool  ')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.getByText('Prompt delivery is unconfirmed.', { exact: false })).toBeVisible()
    await expect(prompt).toHaveValue('  typed-tool  ')
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const conversationId = (catalog.catalog as { conversations: Array<{ id: string }> }).conversations[0].id
    const before = await rpc(daemon.socket, { op: 'draft.send.get', conversation_id: conversationId, window_id:
      JSON.parse(await readFile(join(userData, 'window-owner-v1.json'), 'utf8')).id as string })
    const requestId = (before.intent as { request_id: string }).request_id
    expect(requestId).toBeTruthy()
    const electronProcess = application.process()
    electronProcess.kill('SIGKILL')
    await expect.poll(() => electronProcess.signalCode).toBe('SIGKILL')
    blockComplete = false
    application = await launch()
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const restored = window.getByRole('region', { name: 'Conversation' })
    await expect(restored.getByRole('textbox', { name: 'Prompt' })).toHaveValue('  typed-tool  ')
    await expect(restored.getByText('Prompt delivery is unconfirmed.', { exact: false })).toBeVisible()
    await restored.getByRole('button', { name: 'Retry prompt delivery' }).click()
    await expect(restored.getByRole('textbox', { name: 'Prompt' })).toHaveValue('')
    await expect(restored.locator('.message-assistant')).toContainText('Hello world')
    const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversationId })
    expect((snapshot.messages as Array<{ id: string }>).filter((item) => item.id === requestId)).toHaveLength(1)
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
  } finally {
    await application.close().catch(() => undefined)
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('a delayed prepare commit after a lost reply keeps its ID in the live window', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-prepare-recovery-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory,
  })
  const proxySocket = join(userData, 'proxy.sock')
  let delayPrepare = true
  let heldPrepare: Record<string, unknown> | null = null
  let preparedId = ''
  const peers = new Set<Socket>()
  const proxy = createServer((downstream) => {
    const upstream = createConnection(daemon.socket)
    peers.add(downstream)
    peers.add(upstream)
    let requests = ''
    let replies = ''
    downstream.on('data', (chunk: Buffer) => {
      requests += chunk.toString('utf8')
      for (;;) {
        const end = requests.indexOf('\n')
        if (end < 0) break
        const line = requests.slice(0, end + 1)
        requests = requests.slice(end + 1)
        const request = JSON.parse(line) as { op: string; request_id?: string }
        if (request.op === 'draft.send.prepare' && delayPrepare) {
          delayPrepare = false
          preparedId = request.request_id ?? ''
          heldPrepare = request
          downstream.destroy()
          upstream.destroy()
          break
        }
        upstream.write(line)
      }
    })
    upstream.on('data', (chunk: Buffer) => {
      replies += chunk.toString('utf8')
      for (;;) {
        const end = replies.indexOf('\n')
        if (end < 0) break
        const line = replies.slice(0, end + 1)
        replies = replies.slice(end + 1)
        downstream.write(line)
      }
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy() })
  })
  await new Promise<void>((resolveListen) => proxy.listen(proxySocket, resolveListen))
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await prompt.fill('typed-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.getByText('Prompt delivery is unconfirmed.', { exact: false })).toBeVisible()
    expect(preparedId).toBeTruthy()
    await expect(prompt).toHaveValue('typed-tool')
    const catalogBefore = await rpc(daemon.socket, { op: 'catalog.get' })
    const conversationId = (catalogBefore.catalog as { conversations: Array<{ id: string }> }).conversations[0].id
    const ownerId = (JSON.parse(await readFile(join(userData, 'window-owner-v1.json'), 'utf8')) as { id: string }).id
    expect(await rpc(daemon.socket, { op: 'draft.send.get', conversation_id: conversationId, window_id: ownerId })).toMatchObject({ intent: null })
    expect(heldPrepare).not.toBeNull()
    await rpc(daemon.socket, heldPrepare as Record<string, unknown>)
    await conversation.getByRole('button', { name: 'Retry prompt delivery' }).click()
    await expect(prompt).toHaveValue('')
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversationId })
    expect((snapshot.messages as Array<{ id: string }>).filter((item) => item.id === preparedId)).toHaveLength(1)
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
  } finally {
    await application.close()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('a lost draft completion reply settles on retry without sending again', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-complete-recovery-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory })
  const proxySocket = join(userData, 'proxy.sock')
  let dropCompleteReply = true
  const peers = new Set<Socket>()
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
        const line = replies.slice(0, end + 1)
        replies = replies.slice(end + 1)
        if (operation === 'draft.send.complete' && dropCompleteReply) {
          dropCompleteReply = false
          downstream.destroy()
          upstream.destroy()
          break
        }
        downstream.write(line)
      }
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy() })
  })
  await new Promise<void>((resolveListen) => proxy.listen(proxySocket, resolveListen))
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation' }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await prompt.fill('typed-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.getByText('Prompt delivery is unconfirmed.', { exact: false })).toBeVisible()
    expect(dropCompleteReply).toBe(false)
    await conversation.getByRole('button', { name: 'Retry prompt delivery' }).click()
    await expect(prompt).toHaveValue('')
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
  } finally {
    await application.close()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
