import {
  startConversationProjection,
  type ConversationSnapshot,
  type ProjectionState,
  type SyncFrame,
  type SyncMessage,
} from '@ade/client/sync'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AdeHost } from '../../../shared/bridge'
import { latestPerFrame } from './frame-batch'

// One open conversation: the SDK's projection (snapshot plus feed deltas, with gap and reload
// repair), mirrored into a store at most once per animation frame. The SDK keeps unchanged messages
// as the same objects, so a component that selects one message by ID re-renders only when that
// message changes, not on every token another message receives.

export type ConversationMessage = SyncMessage & Record<string, unknown>
export type Snapshot = ConversationSnapshot<{ id: string } & Record<string, unknown>, ConversationMessage, unknown>
export type ConversationState = ProjectionState<Snapshot>
export type ConversationStore = StoreApi<ConversationState>

export function createConversationStore(
  host: Pick<AdeHost, 'conversations'>,
  conversationId: string,
): { store: ConversationStore; stop: () => void } {
  const store = createStore<ConversationState>(() => ({ status: 'loading', snapshot: null, error: null }))
  const publish = latestPerFrame((state: ConversationState) => store.setState(state, true))
  const stop = startConversationProjection<Snapshot['conversation'], ConversationMessage, unknown>({
    conversationId,
    fetchSnapshot: async (id) =>
      (await host.conversations.request('conversation.get', { conversation_id: id })) as unknown as Snapshot,
    subscribe: (listener) => host.conversations.onFeedFrame((frame) => listener(frame as SyncFrame)),
    onState: publish,
  })
  return { store, stop }
}

/** The message with this ID, or undefined. Stable across updates that do not change it. */
export const selectMessage =
  (id: string) =>
  (state: ConversationState): ConversationMessage | undefined =>
    state.snapshot?.messages.find((message) => message.id === id)

/** Message IDs in display order; a new array only when the set or order changes. */
export function selectMessageIds(): (state: ConversationState) => string[] {
  let previous: string[] = []
  return (state) => {
    const ids = (state.snapshot?.messages ?? []).map((message) => message.id)
    const same = ids.length === previous.length && ids.every((id, index) => id === previous[index])
    if (!same) previous = ids
    return previous
  }
}
