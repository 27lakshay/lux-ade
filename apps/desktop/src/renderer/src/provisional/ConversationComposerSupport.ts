import type { ConversationStore } from '../state/conversation-store'
import type { SubmissionDelivery } from '@ade/contracts'

export const recoveryAdvice: Record<NonNullable<SubmissionDelivery['recovery']>, string> = {
  sign_in: 'Sign in to the provider before trying again.',
  wait_then_retry_manually: 'Wait for the provider, then retry manually.',
  check_account: 'Check the selected account before trying again.',
  reconnect_and_reconcile: 'Reconnect before reconciling this prompt.',
  check_storage: 'Check available storage before trying again.',
  check_provider: 'Check the provider status before trying again.',
}

export const documentFor = (text: string) => ({
  type: 'doc' as const,
  content: text.split('\n').map((line) => ({
    type: 'paragraph' as const,
    ...(line ? { content: [{ type: 'text' as const, text: line }] } : {}),
  })),
})

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
export const hasDeliveryEvidence = (store: ConversationStore, requestId: string): boolean =>
  Boolean(
    store
      .getState()
      .snapshot?.messages.some(
        (message) =>
          message.delivery?.request_id === requestId && message.id === message.delivery.recoverable_message_id,
      ),
  )
