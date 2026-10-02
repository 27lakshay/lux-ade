import { useCallback, useRef, useState } from 'react'
import type { AgentTerminateOutcome } from '@ade/contracts'
import type { StoreApi } from 'zustand/vanilla'
import type { ConversationState } from '../../../state/conversation-store'
import { IN_FLIGHT } from '../../../state/conversation-status'

/**
 * Stop and its declared escalation for one conversation view. Requests target
 * the exact attempt and submission in the latest projection; outcomes come
 * from the daemon's Stop record, never from the request reply.
 */
export function useStopControls(
  conversationId: string,
  store: StoreApi<ConversationState>,
  state: ConversationState,
  isCurrent: () => boolean,
) {
  const host = window.adeHost
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [cancelPending, setCancelPending] = useState(false)
  const cancelPendingRef = useRef(false)
  const [terminating, setTerminating] = useState(false)
  const [terminateOutcome, setTerminateOutcome] = useState<AgentTerminateOutcome | null>(null)
  const [terminateError, setTerminateError] = useState<string | null>(null)
  const live = state.snapshot?.conversation
  const hasStopTarget = Boolean(live?.runtime_run && live.runtime_submission && IN_FLIGHT.has(live.status))
  // The Stop record of the submission still shown; a later submission hides it.
  const stop = live?.stop && live.stop.submission_id === live.runtime_submission ? live.stop : null

  const requestTerminate = useCallback(async (): Promise<void> => {
    const sourceAttemptId = store.getState().snapshot?.conversation.runtime_run
    if (!sourceAttemptId || !isCurrent()) return
    setTerminating(true)
    setTerminateOutcome(null)
    setTerminateError(null)
    try {
      const outcome = await host.conversations.request('agent.terminate', {
        conversation_id: conversationId,
        operation_id: globalThis.crypto.randomUUID(),
        source_attempt_id: sourceAttemptId,
      })
      if (isCurrent()) setTerminateOutcome(outcome)
    } catch (error) {
      if (isCurrent()) setTerminateError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrent()) setTerminating(false)
    }
  }, [conversationId, host, isCurrent, store])

  const requestStop = useCallback(async (): Promise<void> => {
    if (cancelPendingRef.current || !isCurrent()) return
    const latest = store.getState()
    const active = latest.snapshot?.conversation
    const sourceAttemptId = active?.runtime_run
    const submissionId = active?.runtime_submission
    if (latest.status !== 'current' || !sourceAttemptId || !submissionId) {
      setCancelError('The active cancellation target is unavailable; refresh the conversation before trying again.')
      return
    }
    cancelPendingRef.current = true
    setCancelPending(true)
    setCancelError(null)
    setTerminateOutcome(null)
    setTerminateError(null)
    try {
      const turnId = active.active_turn_id
      await host.conversations.request('agent.cancel', {
        conversation_id: conversationId,
        operation_id: globalThis.crypto.randomUUID(),
        source_attempt_id: sourceAttemptId,
        submission_id: submissionId,
        ...(turnId == null ? {} : { turn_id: turnId }),
      })
    } catch (error) {
      if (isCurrent()) setCancelError(error instanceof Error ? error.message : String(error))
    } finally {
      cancelPendingRef.current = false
      if (isCurrent()) setCancelPending(false)
    }
  }, [conversationId, host, isCurrent, store])

  return {
    hasStopTarget,
    stop,
    cancelPending,
    cancelError,
    requestStop,
    terminating,
    terminateOutcome,
    terminateError,
    requestTerminate,
  }
}
