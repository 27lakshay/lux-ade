import { describe, expect, test } from 'vitest'
import { createConversationStore, selectMessage, selectMessageIds } from './conversation-store'
import { createFakeHost, nextFrame } from './fake-host'

const snapshot = (revision: number, messages: { id: string; sequence: number; text: string }[]) => ({
  conversation: { id: 'c1' },
  messages,
  requests: [],
  revision,
  boot_id: 'boot-1',
})
const changed = (revision: number, messages: { id: string; sequence: number; text: string }[]) => ({
  type: 'conversation_changed',
  boot_id: 'boot-1',
  revision,
  conversation: { id: 'c1' },
  messages,
  requests: [],
})
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextFrame()
}

type PendingRead = { promise: Promise<unknown>; resolve: (value: unknown) => void }
const pendingRead = (): PendingRead => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('conversation store', () => {
  test('loads a snapshot through conversation.get', async () => {
    const fake = createFakeHost(async () => snapshot(3, [{ id: 'm1', sequence: 1, text: 'hi' }]))
    const { store } = createConversationStore(fake.host, 'c1')
    await settle()
    expect(selectMessage('m1')(store.getState())).toMatchObject({ text: 'hi' })
  })

  test('a delta replaces only the changed message; others keep their identity', async () => {
    const fake = createFakeHost(async () =>
      snapshot(3, [
        { id: 'm1', sequence: 1, text: 'hi' },
        { id: 'm2', sequence: 2, text: 'partial' },
      ]),
    )
    const { store } = createConversationStore(fake.host, 'c1')
    await settle()
    const first = selectMessage('m1')(store.getState())
    const ids = selectMessageIds()
    const idsBefore = ids(store.getState())
    fake.pushFrame(changed(4, [{ id: 'm2', sequence: 2, text: 'partial and more' }]))
    await settle()
    expect(selectMessage('m1')(store.getState())).toBe(first)
    expect(selectMessage('m2')(store.getState())).toMatchObject({ text: 'partial and more' })
    expect(ids(store.getState())).toBe(idsBefore)
  })

  test('a revision gap fetches a fresh snapshot', async () => {
    let revision = 3
    const fake = createFakeHost(async () => snapshot(revision, [{ id: 'm1', sequence: 1, text: `r${revision}` }]))
    const { store } = createConversationStore(fake.host, 'c1')
    await settle()
    revision = 9
    fake.pushFrame(changed(9, []))
    await settle()
    expect(fake.requests.length).toBe(2)
    expect(selectMessage('m1')(store.getState())).toMatchObject({ text: 'r9' })
  })

  test('a pending read after disposal cannot populate the departed or successor view', async () => {
    const pending = pendingRead()
    const oldHost = createFakeHost(() => pending.promise)
    const departed = createConversationStore(oldHost.host, 'c1')
    departed.stop()

    const nextHost = createFakeHost(async () => snapshot(7, [{ id: 'new', sequence: 7, text: 'successor history' }]))
    const successor = createConversationStore(nextHost.host, 'c1')
    await settle()
    pending.resolve(snapshot(4, [{ id: 'old', sequence: 4, text: 'departed history' }]))
    await settle()

    expect(selectMessage('old')(departed.store.getState())).toBeUndefined()
    expect(selectMessage('new')(successor.store.getState())).toMatchObject({ text: 'successor history' })
    expect(selectMessage('old')(successor.store.getState())).toBeUndefined()
    successor.stop()
  })

  test('disposing cancels a projection update already queued for the next frame', async () => {
    const fake = createFakeHost(async () => snapshot(3, [{ id: 'm1', sequence: 1, text: 'before' }]))
    const view = createConversationStore(fake.host, 'c1')
    await settle()
    fake.pushFrame(changed(4, [{ id: 'm1', sequence: 1, text: 'after' }]))
    view.stop()
    await nextFrame()
    expect(selectMessage('m1')(view.store.getState())).toMatchObject({ text: 'before' })
  })
  test('a throwing feed unsubscribe still cancels queued publication', async () => {
    const fake = createFakeHost(async () => snapshot(3, [{ id: 'm1', sequence: 1, text: 'before' }]))
    const host = {
      ...fake.host,
      conversations: {
        ...fake.host.conversations,
        onFeedFrame: (listener: Parameters<typeof fake.host.conversations.onFeedFrame>[0]) => {
          const unsubscribe = fake.host.conversations.onFeedFrame(listener)
          return () => {
            unsubscribe()
            throw new Error('feed unsubscribe failed')
          }
        },
      },
    }
    const view = createConversationStore(host, 'c1')
    await settle()
    fake.pushFrame(changed(4, [{ id: 'm1', sequence: 1, text: 'after' }]))
    expect(() => view.stop()).toThrow('feed unsubscribe failed')
    await nextFrame()
    expect(selectMessage('m1')(view.store.getState())).toMatchObject({ text: 'before' })
  })
  test('degrades on an oversized live payload, keeps the identified snapshot, then recovers from a fresh read', async () => {
    const recovery = pendingRead()
    const retained = { id: 'm1', sequence: 1, text: 'before' }
    let reads = 0
    const fake = createFakeHost(async () => {
      reads++
      return reads === 1 ? snapshot(3, [retained]) : recovery.promise
    })
    const view = createConversationStore(fake.host, 'c1')
    await settle()
    const oversized = { id: 'huge', sequence: 2, text: 'too large', native_content: 'x'.repeat(8 * 1024 * 1024) }
    fake.pushFrame(changed(4, [oversized]))
    await settle()

    expect(view.store.getState().status).toBe('degraded')
    expect(view.store.getState().error).toMatch(/resource limits/)
    expect(selectMessage('m1')(view.store.getState())).toMatchObject({ text: 'before' })
    expect(selectMessage('huge')(view.store.getState())).toBeUndefined()
    expect(fake.requests).toHaveLength(2)

    recovery.resolve(snapshot(5, [retained, { id: 'm2', sequence: 2, text: 'recovered' }]))
    await settle()
    expect(view.store.getState().status).toBe('current')
    expect(selectMessage('m2')(view.store.getState())).toMatchObject({ text: 'recovered' })
    view.stop()
  })
})
