import { invoke, subscribe } from './ipc'
import { onFeedFrame } from './stream'
import type { ConversationsBridge } from '../shared/bridge/conversations'

export const conversations: ConversationsBridge = {
  request: (op, fields) => invoke('ade:conversation-request', op, fields),
  listPendingSends: () => invoke('ade:pending-sends'),
  exportSendJournal: (profileId, destination) => invoke('ade:send-journal-export', profileId, destination),
  importSendJournal: (bundle, sourceProfileId, targetProfileId) =>
    invoke('ade:send-journal-import', bundle, sourceProfileId, targetProfileId),
  onFeedFrame,
  onDraftError: (listener) => subscribe('ade:draft-error', listener),
}
