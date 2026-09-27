import type { FeedFrame } from '@ade/client'
import type { Frame, PendingSend } from './types'

type DraftError = { conversationId: string; message: string }

/** `window.adeHost.conversations`: the main-process `conversations` module. */
export interface ConversationsBridge {
  request(op: string, fields: Record<string, unknown>): Promise<Frame>
  listPendingSends(): Promise<PendingSend[]>
  exportSendJournal(profileId: string, destination: string): Promise<Record<string, unknown>>
  importSendJournal(bundle: string, sourceProfileId: string, targetProfileId: string): Promise<Record<string, unknown>>
  onFeedFrame(listener: (frame: FeedFrame) => void): () => void
  onDraftError(listener: (value: DraftError) => void): () => void
}
