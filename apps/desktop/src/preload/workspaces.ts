import { invoke } from './ipc'
import type { WorkspacesBridge } from '../shared/bridge/workspaces'

export const workspaces: WorkspacesBridge = {
  open: (folder) => invoke('ade:workspace-open', folder),
  choose: () => invoke('ade:workspace-choose'),
  select: (id, conversationId) => invoke('ade:workspace-select', id, conversationId),
  listRestoreBindings: () => invoke('ade:restore-bindings'),
  rebindRestored: (profileId, kind, id, folder) => invoke('ade:restore-binding', profileId, kind, id, folder),
  chooseRestoreFolder: () => invoke('ade:restore-choose-folder'),
  rename: (id, name) => invoke('ade:workspace-rename', id, name),
  remove: (id) => invoke('ade:workspace-remove', id),
  createWorktree: (projectId, name) => invoke('ade:worktree-create', projectId, name),
  deleteWorktree: (id) => invoke('ade:worktree-delete', id),
}
