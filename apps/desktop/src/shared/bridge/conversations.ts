import type { CallRequest, DailyUseResponse, FeedFrame, ReviewAnchor, ReviewFeedback } from '@ade/client'
import type { ConversationOperation } from './operations'
import type { PendingSend } from './types'

type DraftError = { conversationId: string; message: string }

/** A conversation draft as main holds it; it saves drafts to the daemon in the background. */
export type Draft = {
  text: string
  revision: number
  /**
   * Opaque for now: main passes them between the daemon and its send journal, and the journal does
   * not check their shape. Type them as the contract's attachments when the composer shows them.
   */
  attachments: unknown[]
}

/** The prompt main is still delivering for a conversation, if any. */
export type PendingSendState = {
  request_id: string
  text: string
  state: 'pending' | 'rejected'
  review_anchor?: ReviewAnchor
  review_note?: string | null
  review_feedback?: ReviewFeedback
}

/** The `draft.get`, `draft.save` and `draft.flush` reply: main's draft for a conversation. */
export type DraftState = {
  type: 'draft'
  draft: Draft
  error: string
  /** Text already sent whose clearing from the draft is not yet confirmed. */
  sent_text: string
  send_pending: PendingSendState | null
}

/** A prompt whose delivery is unconfirmed; retrying reuses its request ID. */
export type SendPending = {
  type: 'send_pending'
  request_id: string
  text: string
  message?: string
} & Partial<Omit<PendingSendState, 'request_id' | 'text'>>

/** A prompt the daemon had already accepted, found and acknowledged by reconciliation. */
export type SendReconciled = { type: 'ack'; request_id: string; reconciled: true }

/** How `agent.send` and `agent.retry_send` end. */
export type SendResult = DailyUseResponse<'agent.send'> | SendPending | SendReconciled

/** Requests main answers itself (drafts and the send journal), not by forwarding one daemon call. */
type LocalRequests = {
  'draft.get': { conversation_id: string }
  'draft.save': { conversation_id: string; text: string }
  'draft.flush': { conversation_id: string }
  'agent.send': {
    conversation_id: string
    request_id: string
    /** The prompt; left out when review feedback supplies it. */
    text?: string
    review_anchor?: ReviewAnchor
    note?: string
    review_feedback?: ReviewFeedback
  }
  'agent.retry_send': { conversation_id: string; request_id?: string }
}
type LocalResponses = {
  'draft.get': DraftState
  'draft.save': DraftState
  'draft.flush': DraftState
  'agent.send': SendResult | { type: 'review_rejected'; message: string }
  'agent.retry_send': SendResult
}
type LocalOperation = keyof LocalRequests

export type ConversationRequest<O extends ConversationOperation> = O extends LocalOperation
  ? LocalRequests[O]
  : CallRequest<Exclude<O, LocalOperation>>
export type ConversationResponse<O extends ConversationOperation> = O extends LocalOperation
  ? LocalResponses[O]
  : DailyUseResponse<Exclude<O, LocalOperation>>

/** `pending_sends_exported`: the export's summary. */
export type SendJournalExport = {
  type: 'pending_sends_exported'
  file: string
  format: 'ade-send-journal-bundle-v1'
  source_profile_id: string
  record_count: number
  scope: 'profile-pending-sends-only'
  excluded: string[]
}

/** `pending_sends_imported_held`: the import's summary. Imported prompts stay held. */
export type SendJournalImport = {
  type: 'pending_sends_imported_held'
  source_profile_id: string
  profile_id: string
  record_count: number
  reconciled_count: number
  replay: 'held-until-cross-owner-reconciliation'
}

/** `window.adeHost.conversations`: the main-process `conversations` module. */
export interface ConversationsBridge {
  request<O extends ConversationOperation>(op: O, fields: ConversationRequest<O>): Promise<ConversationResponse<O>>
  listPendingSends(): Promise<PendingSend[]>
  exportSendJournal(profileId: string, destination: string): Promise<SendJournalExport>
  importSendJournal(bundle: string, sourceProfileId: string, targetProfileId: string): Promise<SendJournalImport>
  onFeedFrame(listener: (frame: FeedFrame) => void): () => void
  onDraftError(listener: (value: DraftError) => void): () => void
}
