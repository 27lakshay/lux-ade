import { useCallback, useEffect, useState } from 'react'
import type { Attachment, ContextNodeReply, ContextPlan } from '@ade/contracts'
import type { ConversationsBridge, DraftState } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

/**
 * A draft's attachments and the daemon's plan for them: the form each takes for this provider,
 * or why it would be refused. The plan is read before sending, so a refusal is seen with the
 * draft intact; the daemon checks the same rules again when the prompt is sent.
 */
export function useDraftAttachments({
  conversations,
  conversationId,
  viewId,
  isActiveContext,
}: {
  conversations: ConversationsBridge
  conversationId: string
  viewId: string
  isActiveContext: () => boolean
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // The plan for one exact attachment list; a plan for an earlier list is never shown.
  const [planned, setPlanned] = useState<{ for: Attachment[]; plan: ContextPlan } | null>(null)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback((state: DraftState) => setAttachments(state.draft.attachments as Attachment[]), [])
  const clear = useCallback(() => setAttachments([]), [])

  useEffect(() => {
    let active = true
    if (attachments.length === 0) return
    conversations
      .request('context.plan', { conversation_id: conversationId, attachments })
      .then((next) => {
        if (active && isActiveContext()) setPlanned({ for: attachments, plan: next })
      })
      .catch((error: unknown) => {
        if (active && isActiveContext()) setMessage("Couldn't check these attachments. " + messageOf(error))
      })
    return () => {
      active = false
    }
  }, [attachments, conversationId, conversations, isActiveContext])

  const change = async (request: () => Promise<DraftState>, failure: string): Promise<void> => {
    setWorking(true)
    setMessage(null)
    try {
      const state = await request()
      if (isActiveContext()) load(state)
    } catch (error) {
      if (isActiveContext()) setMessage(failure + messageOf(error))
    } finally {
      if (isActiveContext()) setWorking(false)
    }
  }
  const attach = () =>
    change(
      () => conversations.request('draft.attach', { conversation_id: conversationId, view_id: viewId }),
      "Couldn't attach. The draft is unchanged. ",
    )
  const remove = (attachmentId: string) =>
    change(
      () =>
        conversations.request('draft.detach', {
          conversation_id: conversationId,
          view_id: viewId,
          attachment_id: attachmentId,
        }),
      "Couldn't remove the attachment. ",
    )
  const plan = planned?.for === attachments ? planned.plan : null
  // A captured context node with the exact document each of its attachments carries.
  const preview = useCallback(
    (nodeId: string): Promise<ContextNodeReply> =>
      conversations.request('context.get', { conversation_id: conversationId, node_id: nodeId }),
    [conversationId, conversations],
  )
  return { attachments, plan, working, message, load, attach, remove, clear, preview }
}
