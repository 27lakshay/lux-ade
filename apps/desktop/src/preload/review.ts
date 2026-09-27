import { invoke } from './ipc'
import type { ReviewBridge } from '../shared/bridge/review'

export const review: ReviewBridge = {
  request: (op, fields) => invoke('ade:review-request', op, fields),
  readGitJournal: (workspaceId) => invoke('ade:git-journal-read', workspaceId),
  acknowledgeGitJournal: (workspaceId, requestId, kind) => invoke('ade:git-journal-ack', workspaceId, requestId, kind),
}
