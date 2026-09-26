import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktop = resolve('apps/desktop')
const executable = createRequire(join(desktop, 'package.json'))('electron') as string
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')

test('Electron browses and previews workspace files without exposing linked or HTML content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-files-'))
  const workspaceRoot = join(directory, 'workspace')
  const userData = join(directory, 'electron')
  await mkdir(join(workspaceRoot, 'nested'), { recursive: true })
  await writeFile(join(workspaceRoot, 'nested', 'notes.txt'), 'A workspace note\n')
  await writeFile(join(workspaceRoot, 'picture.png'), png)
  await writeFile(join(workspaceRoot, 'page.html'), '<script>window.adeHost</script>')
  await writeFile(join(directory, 'secret.txt'), 'outside data')
  await symlink(join(directory, 'secret.txt'), join(workspaceRoot, 'nested', 'linked-secret'))
  const daemon = await startDaemon()
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    await rpc(daemon.socket, { op: 'workspace.open', path: workspaceRoot })
    application = await electron.launch({ executablePath: executable, args: [desktop],
      env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
        ADE_E2E_HIDE_WINDOW: '1' } })
    const window = await application.firstWindow()
    await window.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'workspace' })
    const files = window.getByRole('region', { name: 'Workspace files' })
    await expect(files.getByRole('button', { name: 'directory nested' })).toBeVisible()
    await files.getByRole('button', { name: 'directory nested' }).click()
    await files.getByRole('button', { name: 'file nested/notes.txt' }).click()
    await expect(files.getByLabel('File preview')).toContainText('A workspace note')
    await files.getByRole('button', { name: 'symlink nested/linked-secret' }).click()
    await expect(files.getByLabel('File preview')).toContainText('cannot be previewed')
    await files.getByRole('button', { name: 'Up' }).click()
    await files.getByRole('button', { name: 'file picture.png' }).click()
    await expect(files.getByRole('img', { name: 'Preview of picture.png' })).toBeVisible()
    await files.getByRole('button', { name: 'file page.html' }).click()
    await expect(files.getByLabel('File preview')).toContainText('Preview unavailable')
    await expect(files.getByLabel('File preview')).not.toContainText('window.adeHost')
    await files.getByRole('textbox', { name: 'Search file names' }).fill('notes')
    await files.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(files.getByRole('button', { name: 'file nested/notes.txt' })).toBeVisible()
  } finally {
    await application?.close().catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a delayed file listing cannot replace the newly selected workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-files-selection-'))
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  const userData = join(directory, 'electron')
  await mkdir(first)
  await mkdir(second)
  await writeFile(join(first, 'only-first.txt'), 'first')
  await writeFile(join(second, 'only-second.txt'), 'second')
  const daemon = await startDaemon()
  const proxySocket = join(directory, 'proxy.sock')
  const peers = new Set<Socket>()
  let delayListing = false
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
      if (operation === 'file.list' && delayListing) {
        delayListing = false
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
    const files = window.getByRole('region', { name: 'Workspace files' })
    await picker.selectOption({ label: 'first' })
    await expect(files.getByRole('button', { name: 'file only-first.txt' })).toBeVisible()
    delayListing = true
    await files.getByRole('button', { name: 'Refresh' }).click()
    await expect.poll(() => Boolean(releaseHeld)).toBe(true)
    await picker.selectOption({ label: 'second' })
    await expect(files.getByRole('button', { name: 'file only-second.txt' })).toBeVisible()
    releaseHeld?.()
    await expect(files.getByRole('button', { name: 'file only-first.txt' })).toHaveCount(0)
    await expect(files.getByRole('button', { name: 'file only-second.txt' })).toBeVisible()
  } finally {
    releaseHeld?.()
    await application?.close().catch(() => undefined)
    for (const peer of peers) peer.destroy()
    await new Promise<void>((done) => proxy.close(() => done()))
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
