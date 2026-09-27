import type { Conversation, Workspace } from '@ade/client'
import { describe, expect, test } from 'vitest'
import { createDaemonStore } from './daemon-store'
import { clientState, createFakeHost, nextFrame } from './fake-host'

const workspace = (id: string, name = id): Workspace => ({ id, name }) as unknown as Workspace
const conversation = (id: string, title = id): Conversation =>
  ({ id, title, workspace_id: 'w1' }) as unknown as Conversation

describe('daemon store', () => {
  test('normalizes the catalog by ID', async () => {
    const fake = createFakeHost()
    const { store } = createDaemonStore(fake.host)
    fake.pushClientState(
      clientState({ catalog: { workspaces: [workspace('w1'), workspace('w2')], conversations: [conversation('c1')] } }),
    )
    await nextFrame()
    const state = store.getState()
    expect(state.status).toBe('connected')
    expect(state.workspaceIds).toEqual(['w1', 'w2'])
    expect(state.workspaces.w2).toMatchObject({ id: 'w2' })
    expect(state.conversationIds).toEqual(['c1'])
  })

  test('keeps unchanged records and order as the same objects', async () => {
    const fake = createFakeHost()
    const { store } = createDaemonStore(fake.host)
    fake.pushClientState(
      clientState({ catalog: { workspaces: [workspace('w1'), workspace('w2')], conversations: [] } }),
    )
    await nextFrame()
    const before = store.getState()
    fake.pushClientState(
      clientState({
        sequence: 2,
        catalog: { workspaces: [workspace('w1'), workspace('w2', 'renamed')], conversations: [] },
      }),
    )
    await nextFrame()
    const after = store.getState()
    expect(after.workspaces.w1).toBe(before.workspaces.w1)
    expect(after.workspaces.w2).not.toBe(before.workspaces.w2)
    expect(after.workspaceIds).toBe(before.workspaceIds)
  })

  test('applies only the latest of several states pushed within one frame', async () => {
    const fake = createFakeHost()
    const { store } = createDaemonStore(fake.host)
    const seen: string[] = []
    store.subscribe((state) => seen.push(state.status))
    fake.pushClientState(clientState({ status: 'connecting' }))
    fake.pushClientState(clientState({ status: 'reconnecting' as never }))
    fake.pushClientState(clientState({ status: 'connected' }))
    await nextFrame()
    expect(seen.filter((status) => status !== 'connecting')).toEqual(['connected'])
  })

  test('a slow first read does not replace a newer pushed state', async () => {
    const fake = createFakeHost()
    fake.setClientState(clientState({ status: 'connecting' }))
    const { store } = createDaemonStore(fake.host)
    fake.pushClientState(clientState({ status: 'connected', detail: 'pushed' }))
    await nextFrame()
    expect(store.getState().detail).toBe('pushed')
  })
})
