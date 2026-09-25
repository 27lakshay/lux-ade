import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDaemon } from '../fixtures/daemon'

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
        if (request.op === 'conversation.get' && blockSnapshots) {
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
