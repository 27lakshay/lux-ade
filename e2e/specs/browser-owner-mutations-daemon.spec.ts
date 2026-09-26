import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from '../fixtures/daemon'

type Frame = Record<string, unknown>

async function command(socket: string, request: Frame): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(socket)
    let input = ''
    const timer = setTimeout(() => peer.destroy(new Error('Daemon browser command timed out')), 6_000)
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      const end = input.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      peer.destroy()
      try { resolve(JSON.parse(input.slice(0, end)) as Frame) }
      catch (error) { reject(error) }
    })
    peer.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

async function ownerSocket(path: string, received: Frame[], mode: 'ack' | 'drop'): Promise<Server> {
  const server = createServer((peer) => {
    let input = ''
    peer.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      const end = input.indexOf('\n')
      if (end < 0) return
      const request = JSON.parse(input.slice(0, end)) as Frame
      received.push(request)
      if (request.op === 'browser.operation') {
        const previous = received.find((item) => item.op !== 'browser.operation' && item.request_id === request.request_id)
        const fingerprint = previous?.payload_fingerprint ?? 'owner-only-fingerprint'
        peer.end(`${JSON.stringify({ type: 'browser_operation', profile_id: request.profile_id,
          owner_id: request.owner_id, request_id: request.request_id, payload_fingerprint: fingerprint,
          state: 'completed', result: previous ? { type: 'browser_mutation', profile_id: previous.profile_id,
            owner_id: previous.owner_id, request_id: previous.request_id,
            payload_fingerprint: previous.payload_fingerprint, tab_id: previous.tab_id ?? 'tab-open' }
            : { type: 'browser_mutation', tab_id: 'tab-from-owner' } })}\n`)
        return
      }
      if (mode === 'drop') { peer.destroy(); return }
      peer.end(`${JSON.stringify({ type: 'browser_mutation', profile_id: request.profile_id,
        owner_id: request.owner_id, request_id: request.request_id,
        payload_fingerprint: request.payload_fingerprint, tab_id: request.tab_id ?? 'tab-open' })}\n`)
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

test('daemon admits exact browser mutations once and retains unknown outcomes without retargeting', async () => {
  const daemon = await startDaemon()
  const profileId = `fixed-${createHash('sha256').update(daemon.socket).digest('hex').slice(0, 32)}`
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-mutations-'))
  await chmod(directory, 0o700)
  const firstPath = join(directory, 'owner-a.sock')
  const secondPath = join(directory, 'owner-b.sock')
  const firstReceived: Frame[] = []
  const secondReceived: Frame[] = []
  let first: Server | null = null
  let second: Server | null = null
  try {
    const open = { op: 'browser.open', profile_id: profileId, owner_id: 'owner-a',
      request_id: 'open-once', url: 'http://127.0.0.1:18181/preview' }
    expect(await command(daemon.socket, open)).toMatchObject({ type: 'error', code: 'unavailable' })
    first = await ownerSocket(firstPath, firstReceived, 'ack')
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-a', socket_path: firstPath })).toMatchObject({ type: 'browser_owner' })
    expect(await command(daemon.socket, { ...open, debug: true })).toMatchObject({ type: 'error', code: 'invalid_request' })
    expect(await command(daemon.socket, { ...open, request_id: '' })).toMatchObject({ type: 'error', code: 'invalid_request' })
    const created = await command(daemon.socket, open)
    expect(created).toMatchObject({ type: 'browser_mutation', profile_id: profileId,
      owner_id: 'owner-a', request_id: 'open-once', tab_id: 'tab-open' })
    const expectedFingerprint = createHash('sha256').update(JSON.stringify([
      'browser.open', profileId, 'owner-a', null, open.url,
    ])).digest('hex')
    expect(created.payload_fingerprint).toBe(expectedFingerprint)
    expect(await command(daemon.socket, open)).toEqual(created)
    expect(firstReceived).toHaveLength(1)
    expect(await command(daemon.socket, { ...open, url: 'http://127.0.0.1:18181/other' }))
      .toMatchObject({ type: 'error', code: 'conflict' })
    expect(await command(daemon.socket, { op: 'browser.operation', profile_id: profileId,
      request_id: 'open-once' })).toMatchObject({ type: 'browser_operation', state: 'completed', result: created })
    expect(await command(daemon.socket, { op: 'browser.operation', request_id: 'owner-only-id' }))
      .toMatchObject({ type: 'browser_operation', profile_id: profileId, owner_id: 'owner-a',
        request_id: 'owner-only-id', state: 'completed', result: { tab_id: 'tab-from-owner' } })

    const navigate = { op: 'browser.navigate', profile_id: profileId, owner_id: 'owner-a',
      request_id: 'navigate-once', tab_id: 'tab-open', url: 'https://example.test/next' }
    expect(await command(daemon.socket, navigate)).toMatchObject({ type: 'browser_mutation', tab_id: 'tab-open' })
    const close = { op: 'browser.close', profile_id: profileId, owner_id: 'owner-a',
      request_id: 'close-once', tab_id: 'tab-open' }
    expect(await command(daemon.socket, close)).toMatchObject({ type: 'browser_mutation', tab_id: 'tab-open' })
    expect(firstReceived).toHaveLength(4)

    await closeOwner(first)
    first = null
    first = await ownerSocket(firstPath, firstReceived, 'drop')
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-a', socket_path: firstPath })).toMatchObject({ type: 'browser_owner' })
    const lost = { op: 'browser.navigate', profile_id: profileId, owner_id: 'owner-a',
      request_id: 'lost-reply', tab_id: 'tab-open', url: 'https://example.test/uncertain' }
    expect(await command(daemon.socket, lost)).toMatchObject({ type: 'error', code: 'outcome_unknown' })
    expect(await command(daemon.socket, lost)).toMatchObject({ type: 'error', code: 'outcome_unknown' })
    expect(firstReceived.filter((item) => item.request_id === 'lost-reply')).toHaveLength(1)
    expect(await command(daemon.socket, { op: 'browser.operation', profile_id: profileId,
      request_id: 'lost-reply' })).toMatchObject({ type: 'browser_operation', state: 'completed',
        result: { request_id: 'lost-reply', tab_id: 'tab-open' } })
    expect(await command(daemon.socket, { op: 'browser.operation', request_id: 'lost-reply' }))
      .toMatchObject({ type: 'browser_operation', profile_id: profileId, state: 'completed' })
    expect(await command(daemon.socket, { op: 'browser.operation', profile_id: 'profile-b',
      request_id: 'lost-reply' })).toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await command(daemon.socket, lost)).toMatchObject({ type: 'browser_mutation', request_id: 'lost-reply' })
    expect(firstReceived.filter((item) => item.op === 'browser.navigate' && item.request_id === 'lost-reply'))
      .toHaveLength(1)

    const gone = { ...lost, request_id: 'lost-owner', url: 'https://example.test/gone' }
    expect(await command(daemon.socket, gone)).toMatchObject({ type: 'error', code: 'outcome_unknown' })

    await closeOwner(first)
    first = null
    expect(await command(daemon.socket, { op: 'browser.operation', request_id: 'lost-owner' }))
      .toMatchObject({ type: 'browser_operation', state: 'unknown' })
    second = await ownerSocket(secondPath, secondReceived, 'ack')
    expect(await command(daemon.socket, { op: 'browser.owner.register', profile_id: profileId,
      owner_id: 'owner-b', socket_path: secondPath })).toMatchObject({ type: 'browser_owner' })
    expect(await command(daemon.socket, { ...lost, owner_id: 'owner-b' }))
      .toMatchObject({ type: 'error', code: 'conflict' })
    expect(await command(daemon.socket, { ...open, owner_id: 'owner-b' }))
      .toMatchObject({ type: 'error', code: 'conflict' })
    expect(secondReceived).toHaveLength(0)
  } finally {
    if (first) await closeOwner(first)
    if (second) await closeOwner(second)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
