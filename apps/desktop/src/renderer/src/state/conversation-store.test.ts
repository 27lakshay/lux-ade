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

describe('conversation store', () => {
  test('loads a snapshot through conversation.get', async () => {
    const fake = createFakeHost(async () => snapshot(3, [{ id: 'm1', sequence: 1, text: 'hi' }]))
    const { store } = createConversationStore(fake.host, 'c1')
    await settle()
    expect(fake.requests[0]).toEqual({ op: 'conversation.get', fields: { conversation_id: 'c1' } })
    expect(store.getState().status).toBe('current')
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
})
