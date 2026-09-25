import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('conversation feed applies deltas and resnapshots after a missing revision', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-feed-e2e-'))
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: join(userData, 'codex'),
  })
  const proxySocket = join(userData, 'feed.sock')
  const peers = new Set<Socket>()
  let skipNextChange = false
  let skipped = false
  let changes = 0
  let snapshotReads = 0
  let subscriptions = 0
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
        if (operation === 'conversation.get') snapshotReads++
        if (operation === 'session.subscribe') subscriptions++
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
        if (operation === 'session.subscribe' && response.type === 'conversation_changed') {
          changes++
          if (skipNextChange && !skipped) { skipped = true; continue }
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
    await expect(conversation.getByText('Send a prompt to start this conversation.')).toBeVisible()
    skipNextChange = true
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('typed-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    await expect(conversation.locator('.message-tool')).toContainText('fixture failure')
    await expect.poll(() => skipped).toBe(true)
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('typed-tool again')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.locator('.message-assistant')).toHaveCount(2)
    await expect.poll(() => subscriptions).toBeGreaterThan(1)
    expect(changes).toBeGreaterThan(1)
    expect(snapshotReads).toBeLessThanOrEqual(6)
    const readsAtRest = snapshotReads
    await window.waitForTimeout(2_300)
    expect(snapshotReads).toBe(readsAtRest)
  } finally {
    await application.close()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
