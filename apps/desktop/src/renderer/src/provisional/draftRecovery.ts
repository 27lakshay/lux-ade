import type { DraftStash } from '@ade/contracts'
import type { Editor } from '@tiptap/react'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { documentFor, messageOf } from './ConversationComposerSupport'

/**
 * Listing and restoring saved draft copies for one composer. Each step first saves the pending
 * draft, and holds the composer busy so no send or other recovery step runs meanwhile.
 */
export function draftRecovery({
  conversations,
  conversationId,
  viewId,
  editor,
  isActiveContext,
  isMounted,
  busyRef,
  attemptRef,
  textRef,
  flushPendingSave,
  setRecoveryBusy,
  setDraftStashes,
  setContextNodes,
  setDetail,
}: {
  conversations: ConversationsBridge
  conversationId: string
  viewId: string
  editor: Editor | null
  isActiveContext: () => boolean
  isMounted: () => boolean
  busyRef: { current: boolean }
  attemptRef: { current: unknown }
  textRef: { current: string }
  flushPendingSave: () => Promise<void>
  setRecoveryBusy: (busy: boolean) => void
  setDraftStashes: (stashes: DraftStash[] | null) => void
  setContextNodes: (nodes: unknown[]) => void
  setDetail: (detail: string | null) => void
}) {
  const withRecovery = async (step: () => Promise<void>, failure: string): Promise<void> => {
    if (!isActiveContext() || busyRef.current || attemptRef.current) return
    busyRef.current = true
    setRecoveryBusy(true)
    try {
      await flushPendingSave()
      await step()
    } catch (error) {
      if (isActiveContext()) setDetail(failure + messageOf(error))
    } finally {
      busyRef.current = false
      if (isMounted()) setRecoveryBusy(false)
    }
  }
  const openDraftRecovery = (): Promise<void> =>
    withRecovery(async () => {
      const result = await conversations.request('draft.stash.list', {
        conversation_id: conversationId,
        view_id: viewId,
      })
      if (!isActiveContext()) return
      setDraftStashes(result.stashes)
      setDetail(
        result.stashes.length ? 'Choose a saved draft to restore.' : 'No saved draft recovery copies are available.',
      )
    }, 'Could not load saved draft recovery. ')
  const restoreDraftRecovery = (stash: DraftStash): Promise<void> =>
    withRecovery(async () => {
      const state = await conversations.request('draft.stash.restore', {
        conversation_id: conversationId,
        view_id: viewId,
        name: stash.name,
        stash_revision: stash.revision,
      })
      if (!isActiveContext()) return
      if (state.error) {
        setDetail(state.error)
        return
      }
      textRef.current = state.draft.text
      setContextNodes(state.draft.context_nodes ?? [])
      editor?.commands.setContent(documentFor(state.draft.text), { emitUpdate: false })
      setDraftStashes(null)
      setDetail('Saved draft restored. The displaced draft remains available in recovery.')
    }, 'Could not restore the saved draft. ')
  return { openDraftRecovery, restoreDraftRecovery }
}
