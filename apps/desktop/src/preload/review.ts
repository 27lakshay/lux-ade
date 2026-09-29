import { forward, invoke } from './ipc'
import type { ReviewBridge } from '../shared/bridge/review'

export const review: ReviewBridge = {
  request: forward('ade:review-request'),
  sendFeedback: (conversationId, feedback) => invoke('ade:review-feedback-send', conversationId, feedback),
  readGitJournal: (workspaceId) => invoke('ade:git-journal-read', workspaceId),
  acknowledgeGitJournal: (workspaceId, requestId, kind) => invoke('ade:git-journal-ack', workspaceId, requestId, kind),
}
