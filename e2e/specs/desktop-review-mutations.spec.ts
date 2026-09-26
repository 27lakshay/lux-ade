import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)
const desktop = resolve('apps/desktop')
const executable = createRequire(join(desktop, 'package.json'))('electron') as string

test('Electron stages, unstages and commits only the reviewed workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-git-'))
  const checkout = join(directory, 'checkout')
  const other = join(directory, 'other')
  const userData = join(directory, 'electron')
  for (const folder of [checkout, other]) {
    await run('git', ['init', '-q', '-b', 'main', folder])
    await run('git', ['-C', folder, 'config', 'user.name', 'ADE Fixture'])
    await run('git', ['-C', folder, 'config', 'user.email', 'ade@example.invalid'])
    await writeFile(join(folder, 'tracked.txt'), 'baseline\n')
    await run('git', ['-C', folder, 'add', 'tracked.txt'])
    await run('git', ['-C', folder, 'commit', '-qm', 'baseline'])
    await writeFile(join(folder, 'tracked.txt'), `${folder} updated\n`)
  }
  const daemon = await startDaemon()
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    await rpc(daemon.socket, { op: 'workspace.open', path: checkout })
    await rpc(daemon.socket, { op: 'workspace.open', path: other })
    application = await electron.launch({ executablePath: executable, args: [desktop],
      env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
        ADE_E2E_HIDE_WINDOW: '1' } })
    const window = await application.firstWindow()
    const picker = window.getByRole('combobox', { name: 'Workspace', exact: true })
    await picker.selectOption({ label: 'checkout' })
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByRole('button', { name: 'Stage tracked.txt' })).toBeVisible()
    await changes.getByRole('button', { name: 'Stage tracked.txt' }).click()
    await expect(changes.getByRole('button', { name: 'Unstage tracked.txt' })).toBeVisible()
    expect((await run('git', ['-C', other, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('')
    await changes.getByRole('button', { name: 'Unstage tracked.txt' }).click()
    await expect(changes.getByRole('button', { name: 'Stage tracked.txt' })).toBeVisible()
    await changes.getByRole('button', { name: 'Stage tracked.txt' }).click()
    await expect(changes.getByRole('button', { name: 'Unstage tracked.txt' })).toBeVisible()
    await changes.getByRole('textbox', { name: 'Commit message' }).fill('ADE reviewed commit')
    await changes.getByRole('button', { name: 'Commit staged changes' }).click()
    await expect(changes.getByText('No changed files in this workspace.')).toBeVisible()
    expect((await run('git', ['-C', checkout, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('ADE reviewed commit')
    expect((await run('git', ['-C', other, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('baseline')
    await picker.selectOption({ label: 'other' })
    await expect(changes.getByRole('button', { name: 'Stage tracked.txt' })).toBeVisible()
  } finally {
    await application?.close().catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a delayed Git admission reply stays bound to its original workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-git-selection-'))
  const userData = join(directory, 'electron')
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  for (const [folder, name] of [[first, 'first.txt'], [second, 'second.txt']]) {
    await run('git', ['init', '-q', '-b', 'main', folder])
    await writeFile(join(folder, name), 'baseline\n')
    await run('git', ['-C', folder, 'add', name])
    await run('git', ['-C', folder, '-c', 'user.name=ADE Fixture', '-c', 'user.email=ade@example.invalid',
      'commit', '-qm', 'baseline'])
    await writeFile(join(folder, name), 'changed\n')
  }
  const daemon = await startDaemon()
  const proxySocket = join(directory, 'proxy.sock')
  const peers = new Set<Socket>()
  let holdStage = false
  let releaseHeld: (() => void) | null = null
  const proxy = createServer((downstream) => {
    const upstream = createConnection(daemon.socket)
    peers.add(downstream); peers.add(upstream)
    let requestText = ''
    let replyText = ''
    let operation = ''
    let held = false
    downstream.on('data', (chunk: Buffer) => {
      requestText += chunk.toString('utf8')
      const end = requestText.indexOf('\n')
      if (end < 0) return
      const line = requestText.slice(0, end + 1)
      operation = (JSON.parse(line) as { op: string }).op
      upstream.write(line)
      requestText = requestText.slice(end + 1)
    })
    upstream.on('data', (chunk: Buffer) => {
      replyText += chunk.toString('utf8')
      const end = replyText.indexOf('\n')
      if (end < 0) return
      const line = replyText.slice(0, end + 1)
      if (operation === 'review.stage' && holdStage) {
        holdStage = false
        held = true
        releaseHeld = () => { downstream.write(line); downstream.end(); held = false; releaseHeld = null }
      } else downstream.write(line)
      replyText = replyText.slice(end + 1)
    })
    downstream.on('error', () => undefined)
    upstream.on('error', () => undefined)
    upstream.on('close', () => { peers.delete(upstream); if (!held) downstream.end() })
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy() })
  })
  await new Promise<void>((done) => proxy.listen(proxySocket, done))
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    await rpc(daemon.socket, { op: 'workspace.open', path: first })
    await rpc(daemon.socket, { op: 'workspace.open', path: second })
    application = await electron.launch({ executablePath: executable, args: [desktop],
      env: { ...process.env, ADE_SOCKET: proxySocket, ADE_E2E_USER_DATA_DIR: userData,
        ADE_E2E_HIDE_WINDOW: '1' } })
    const window = await application.firstWindow()
    const picker = window.getByRole('combobox', { name: 'Workspace', exact: true })
    const changes = window.getByRole('region', { name: 'Changes' })
    await picker.selectOption({ label: 'first' })
    await expect(changes.getByRole('button', { name: 'Stage first.txt' })).toBeVisible()
    holdStage = true
    await changes.getByRole('button', { name: 'Stage first.txt' }).click()
    await expect.poll(() => Boolean(releaseHeld)).toBe(true)
    await picker.selectOption({ label: 'second' })
    await expect(changes.getByRole('button', { name: 'Stage second.txt' })).toBeVisible()
    releaseHeld?.()
    await expect(changes.getByRole('button', { name: 'Stage first.txt' })).toHaveCount(0)
    expect((await run('git', ['-C', second, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('')
    await picker.selectOption({ label: 'first' })
    await expect(changes.getByRole('button', { name: 'Unstage first.txt' })).toBeVisible()
  } finally {
    releaseHeld?.()
    await application?.close().catch(() => undefined)
    for (const peer of peers) peer.destroy()
    await new Promise<void>((done) => proxy.close(() => done()))
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Electron reopens with the original Git operation ID after a process crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-git-recovery-'))
  const checkout = join(directory, 'checkout')
  const pause = join(directory, 'pause')
  const userData = join(directory, 'electron')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await run('git', ['-C', checkout, '-c', 'user.name=ADE Fixture', '-c', 'user.email=ade@example.invalid',
    'commit', '-qm', 'baseline'])
  await writeFile(join(checkout, 'tracked.txt'), 'changed\n')
  const daemon = await startDaemon({ ADE_E2E_REVIEW_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' })
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const env = { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1' }
    application = await electron.launch({ executablePath: executable, args: [desktop], env })
    let window = await application.firstWindow()
    await window.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'checkout' })
    let changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByRole('button', { name: 'Stage tracked.txt' })).toBeVisible()
    await writeFile(join(pause, 'armed'), '')
    await changes.getByRole('button', { name: 'Stage tracked.txt' }).click()
    await expect.poll(() => stat(join(pause, 'signal')).then(() => true, () => false)).toBe(true)
    const operationText = await changes.locator('.review-operation').textContent()
    const pendingId = operationText?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
    expect(pendingId).toEqual(expect.any(String))
    application.process().kill('SIGKILL')
    await application.close().catch(() => undefined)
    application = await electron.launch({ executablePath: executable, args: [desktop], env })
    window = await application.firstWindow()
    await window.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'checkout' })
    changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.locator('.review-operation')).toContainText(pendingId!)
    await writeFile(join(pause, 'release'), '')
    await expect(changes.getByRole('button', { name: 'Unstage tracked.txt' })).toBeVisible()
    const receipt = await rpc(daemon.socket, { op: 'review.operation',
      workspace_id: workspace.id, request_id: pendingId })
    expect(receipt.operation).toMatchObject({ id: pendingId, status: 'succeeded' })
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await application?.close().catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
