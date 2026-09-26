import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from '../fixtures/daemon'

async function command(socket: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(socket)
    let input = ''
    const timer = setTimeout(() => peer.destroy(new Error('Daemon browser command timed out')), 5_000)
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      const end = input.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      peer.destroy()
      try { resolve(JSON.parse(input.slice(0, end)) as Record<string, unknown>) }
      catch (error) { reject(error) }
    })
    peer.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

async function ownerSocket(path: string, received: Array<Record<string, unknown>>, tabOverride?: string): Promise<Server> {
  const server = createServer((peer) => {
    let input = ''
    peer.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      const end = input.indexOf('\n')
      if (end < 0) return
      const request = JSON.parse(input.slice(0, end)) as Record<string, unknown>
      received.push(request)
      peer.end(`${JSON.stringify({ type: 'browser_snapshot', profile_id: request.profile_id,
        owner_id: request.owner_id, tab_id: tabOverride ?? request.tab_id ?? null })}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  await chmod(path, 0o600)
  return server
}

async function closeOwner(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('daemon forwards browser reads only to the exact live private owner', async () => {
  const daemon = await startDaemon()
  const profileId = `fixed-${createHash('sha256').update(daemon.socket).digest('hex').slice(0, 32)}`
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-owner-'))
  await chmod(directory, 0o700)
  const firstPath = join(directory, 'first.sock')
  const secondPath = join(directory, 'second.sock')
  const firstReceived: Array<Record<string, unknown>> = []
  const secondReceived: Array<Record<string, unknown>> = []
  let first: Server | null = null
  let second: Server | null = null
  try {
    const unavailable = await command(daemon.socket, { op: 'browser.owner.get', profile_id: profileId })
    expect(unavailable).toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.owner.get' }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.owner.get', profile_id: 'profile-b' }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    first = await ownerSocket(firstPath, firstReceived)
    await chmod(firstPath, 0o666)
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-a', socket_path: firstPath })).toMatchObject({ type: 'error', code: 'invalid_request' })
    await chmod(firstPath, 0o600)
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-a', socket_path: firstPath })).toMatchObject({ type: 'browser_owner',
      profile_id: profileId, owner_id: 'owner-a' })
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-a', socket_path: firstPath })).toMatchObject({ type: 'browser_owner' })
    expect(await command(daemon.socket, { op: 'browser.owner.get', profile_id: profileId }))
      .toMatchObject({ type: 'browser_owner', owner_id: 'owner-a' })
    expect(await command(daemon.socket, { op: 'browser.owner.get' }))
      .toMatchObject({ type: 'browser_owner', profile_id: profileId, owner_id: 'owner-a' })
    expect(await command(daemon.socket, { op: 'browser.owner.get', profile_id: 'profile-b' }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.list', profile_id: profileId, owner_id: 'owner-a' }))
      .toMatchObject({ type: 'browser_snapshot', profile_id: profileId, owner_id: 'owner-a' })
    expect(await command(daemon.socket, { op: 'browser.inspect', profile_id: profileId,
      owner_id: 'owner-a', tab_id: 'tab-123' })).toMatchObject({ type: 'browser_snapshot', tab_id: 'tab-123' })
    expect(firstReceived).toEqual([
      { op: 'browser.list', profile_id: profileId, owner_id: 'owner-a' },
      { op: 'browser.inspect', profile_id: profileId, owner_id: 'owner-a', tab_id: 'tab-123' },
    ])
    second = await ownerSocket(secondPath, secondReceived, 'wrong-tab')
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: 'profile-b',
      owner_id: 'owner-b', socket_path: secondPath })).toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-b', socket_path: secondPath })).toMatchObject({ type: 'error', code: 'conflict' })
    expect(await command(daemon.socket, { op: 'browser.list', profile_id: 'profile-b', owner_id: 'owner-b' }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.list', profile_id: profileId, owner_id: 'owner-b' }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(secondReceived).toHaveLength(0)
    await closeOwner(first)
    first = null
    expect(await command(daemon.socket, { op: 'browser.owner.get', profile_id: profileId }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-b', socket_path: secondPath })).toMatchObject({ type: 'browser_owner', owner_id: 'owner-b' })
    expect(await command(daemon.socket, { op: 'browser.list', profile_id: profileId, owner_id: 'owner-a' }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.owner.unregister', profile_id: profileId,
      owner_id: 'owner-a' })).toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, { op: 'browser.list', profile_id: profileId, owner_id: 'owner-b' }))
      .toMatchObject({ type: 'browser_snapshot', profile_id: profileId, owner_id: 'owner-b' })
    expect(await command(daemon.socket, { op: 'browser.inspect', profile_id: profileId,
      owner_id: 'owner-b', tab_id: 'target-tab' })).toMatchObject({ type: 'error', code: 'unavailable' })
    expect(secondReceived).toHaveLength(2)
    expect(await command(daemon.socket, { op: 'browser.owner.unregister', profile_id: profileId,
      owner_id: 'owner-b' })).toMatchObject({ type: 'ack' })
    expect(await command(daemon.socket, { op: 'browser.owner.get', profile_id: profileId }))
      .toMatchObject({ type: 'error', code: 'unavailable' })
  } finally {
    if (first) await closeOwner(first)
    if (second) await closeOwner(second)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
