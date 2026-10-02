import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import type { ConversationStore } from '../state/conversation-store'
import { IN_FLIGHT } from '../state/conversation-status'
import { messageOf } from './ConversationComposerSupport'

type Pending = { id: string; text: string }

/**
 * Queue and Steer for a busy conversation. They are separate actions with their
 * own daemon operations, never a Send in disguise: Queue adds to ADE's durable
 * queue, and Steer asks the provider to add input to the named active turn.
 * Each keeps its ID with its text, so a retry after a lost reply reuses the ID
 * and the daemon returns the first outcome instead of acting twice.
 */
export function useFollowUpInput({
  conversations,
  conversationId,
  store,
  isActiveContext,
  takeText,
  clear,
}: {
  conversations: ConversationsBridge
  conversationId: string
  store: ConversationStore
  isActiveContext: () => boolean
  /** The prompt this input delivers, prepared exactly as Send prepares it, or why it cannot go. */
  takeText: () => { text: string } | { refused: string }
  clear: () => Promise<void>
}) {
  const conversation = useStore(store, (state) => state.snapshot?.conversation)
  const queuedCount = useStore(store, (state) => state.snapshot?.queued?.length ?? 0)
  const turnActive = Boolean(conversation && IN_FLIGHT.has(conversation.status))
  const activeTurnId = conversation?.active_turn_id ?? null
  // Availability is fetched per active turn and applies only to that turn.
  const [steerFor, setSteerFor] = useState<{ turnId: string; available: boolean; reason: string | null } | null>(null)
  const steer = steerFor && steerFor.turnId === activeTurnId ? steerFor : null
  const [working, setWorking] = useState<'queue' | 'steer' | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const queuePending = useRef<Pending | null>(null)
  const steerPending = useRef<Pending | null>(null)

  useEffect(() => {
    if (!activeTurnId) return
    let current = true
    conversations
      .request('conversation.controls', { conversation_id: conversationId })
      .then((reply) => {
        const control = reply.controls.find((item) => item.control === 'steer')
        if (current)
          setSteerFor({ turnId: activeTurnId, available: control?.available ?? false, reason: control?.reason ?? null })
      })
      .catch((error: unknown) => {
        if (current)
          setSteerFor({
            turnId: activeTurnId,
            available: false,
            reason: 'Steering availability is unknown. ' + messageOf(error),
          })
      })
    return () => {
      current = false
    }
  }, [activeTurnId, conversationId, conversations])

  const pendingFor = (slot: { current: Pending | null }, text: string): Pending => {
    if (slot.current?.text !== text) slot.current = { id: crypto.randomUUID(), text }
    return slot.current
  }

  const queue = useCallback(async (): Promise<void> => {
    const taken = takeText()
    if ('refused' in taken) return setDetail(taken.refused)
    const text = taken.text
    if (!text.trim() || working || !isActiveContext()) return
    const pending = pendingFor(queuePending, text)
    setWorking('queue')
    setDetail(null)
    try {
      await conversations.request('queue.enqueue', {
        conversation_id: conversationId,
        request_id: pending.id,
        text,
      })
      queuePending.current = null
      await clear()
    } catch (error) {
      if (isActiveContext()) setDetail("Couldn't queue this prompt; it stays in the editor. " + messageOf(error))
    } finally {
      if (isActiveContext()) setWorking(null)
    }
  }, [clear, conversationId, conversations, isActiveContext, takeText, working])

  const steerTurn = useCallback(async (): Promise<void> => {
    const taken = takeText()
    if ('refused' in taken) return setDetail(taken.refused)
    const text = taken.text
    if (!text.trim() || working || !activeTurnId || !isActiveContext()) return
    const pending = pendingFor(steerPending, text)
    setWorking('steer')
    setDetail(null)
    try {
      const reply = await conversations.request('conversation.steer', {
        operation_id: pending.id,
        conversation_id: conversationId,
        turn_id: activeTurnId,
        text,
      })
      if (reply.outcome === 'acknowledged') {
        steerPending.current = null
        await clear()
      } else if (isActiveContext()) {
        // A refused or unavailable steer is not sent anywhere else; the text stays here.
        if (reply.outcome !== 'unknown') steerPending.current = null
        setDetail(
          (reply.outcome === 'unknown'
            ? 'Steering may or may not have reached the turn; retry to read its outcome. '
            : 'The turn did not take this input. ') + (reply.reason ?? ''),
        )
      }
    } catch (error) {
      if (isActiveContext()) setDetail("Couldn't steer the turn; the text stays in the editor. " + messageOf(error))
    } finally {
      if (isActiveContext()) setWorking(null)
    }
  }, [activeTurnId, clear, conversationId, conversations, isActiveContext, takeText, working])

  return {
    /** Send must wait while a turn runs or earlier prompts are queued. */
    sendBlocked: turnActive || queuedCount > 0,
    turnActive,
    steer: turnActive && activeTurnId ? steer : null,
    working,
    detail,
    queue,
    steerTurn,
  }
}
