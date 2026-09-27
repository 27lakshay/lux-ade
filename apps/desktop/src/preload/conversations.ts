import { ipcRenderer } from 'electron'
import type { ConversationsBridge } from '../renderer/src/host/conversations'
import { subscribe } from './subscribe'

export const conversations: ConversationsBridge = {
  request: (op, fields) => ipcRenderer.invoke('ade:conversation-request', op, fields),
  listPendingSends: () => ipcRenderer.invoke('ade:pending-sends'),
  exportSendJournal: (profileId, destination) => ipcRenderer.invoke('ade:send-journal-export', profileId, destination),
  importSendJournal: (bundle, sourceProfileId, targetProfileId) =>
    ipcRenderer.invoke('ade:send-journal-import', bundle, sourceProfileId, targetProfileId),
  onFeedFrame: (listener) => subscribe('ade:feed-frame', listener),
  onDraftError: (listener) => subscribe('ade:draft-error', listener),
}
