import { invoke, subscribe } from './ipc'
import type { LayoutsBridge } from '../shared/bridge/layouts'

export const layouts: LayoutsBridge = {
  windowId: () => invoke('ade:window-id'),
  onWindowId: (listener) => subscribe('ade:window-id-changed', listener),
  get: (workspaceId) => invoke('ade:layout-get', workspaceId),
  apply: (workspaceId, action, expectedRevision) => invoke('ade:layout-apply', workspaceId, action, expectedRevision),
  replace: (workspaceId, layout, expectedRevision) =>
    invoke('ade:layout-replace', workspaceId, layout, expectedRevision),
  closeTab: (workspaceId, tabId, force) => invoke('ade:tab-close', workspaceId, tabId, force),
  closePane: (workspaceId, paneId, force) => invoke('ade:pane-close', workspaceId, paneId, force),
  showWorkspace: (workspaceId) => invoke('ade:window-show-workspace', workspaceId),
  setCollapsedProjects: (projectIds) => invoke('ade:window-collapse', projectIds),
}
