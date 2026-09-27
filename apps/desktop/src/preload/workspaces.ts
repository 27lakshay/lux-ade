import { ipcRenderer } from 'electron'
import type { WorkspacesBridge } from '../renderer/src/host/workspaces'

export const workspaces: WorkspacesBridge = {
  open: (folder) => ipcRenderer.invoke('ade:workspace-open', folder),
  choose: () => ipcRenderer.invoke('ade:workspace-choose'),
  select: (id, conversationId) => ipcRenderer.invoke('ade:workspace-select', id, conversationId),
  listRestoreBindings: () => ipcRenderer.invoke('ade:restore-bindings'),
  rebindRestored: (profileId, kind, id, folder) => ipcRenderer.invoke('ade:restore-binding', profileId, kind, id, folder),
  chooseRestoreFolder: () => ipcRenderer.invoke('ade:restore-choose-folder'),
}
