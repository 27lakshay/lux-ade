import { ipcRenderer } from 'electron'
import type { ReviewBridge } from '../renderer/src/host/review'

export const review: ReviewBridge = {
  request: (op, fields) => ipcRenderer.invoke('ade:review-request', op, fields),
  readGitJournal: (workspaceId) => ipcRenderer.invoke('ade:git-journal-read', workspaceId),
  acknowledgeGitJournal: (workspaceId, requestId, kind) =>
    ipcRenderer.invoke('ade:git-journal-ack', workspaceId, requestId, kind),
}
