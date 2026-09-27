import { BrowserWindow, dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { dailyUseCommand, requestDaemon } from '@ade/client'
import { getClient, getClientGeneration, getProfileState, getSocket, getStartupProfileSelection, isRestoringBinding,
  isSwitching, managedProfiles, setRestoringBinding } from './profile-connection'
import { validId } from './validation'

export const selectedWorkspaces = new Map<number, { workspaceId: string; conversationId: string | null; generation: number; epoch: number }>()
export const selectionRequests = new Map<number, number>()
async function openWorkspace(folder: unknown): Promise<Record<string, unknown>> {
  if (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096) throw new Error('Choose an absolute folder path')
  if (!(await stat(folder)).isDirectory()) throw new Error('The selected path is not a folder')
  const endpoint = getSocket()
  if (getClient().getState().status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
  return dailyUseCommand(endpoint, { op: 'workspace.open', path: folder })
}
export function registerWorkspaceIpc(): void {
  ipcMain.handle('ade:workspace-open', (_event, folder: unknown) => openWorkspace(folder))
  ipcMain.handle('ade:workspace-choose', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open workspace', properties: ['openDirectory'], buttonLabel: 'Open workspace',
    }
    const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    if (result.canceled || !result.filePaths[0]) return null
    return openWorkspace(result.filePaths[0])
  })
  ipcMain.handle('ade:restore-bindings', async () => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    const endpoint = getSocket()
    const generation = getClientGeneration()
    if (!endpoint || isSwitching() || getClient().getState().status !== 'connected') throw new Error('Profile daemon is unavailable')
    const [lifecycle, repositories, workspaces] = await Promise.all([
      dailyUseCommand(endpoint, { op: 'worktree.rebind.list' }),
      dailyUseCommand(endpoint, { op: 'repository.rebind.list' }),
      dailyUseCommand(endpoint, { op: 'workspace.rebind.list' }),
    ])
    if (getSocket() !== endpoint || getClientGeneration() !== generation || isSwitching()) throw new Error('Profile changed while loading recovery state')
    if (!Array.isArray(lifecycle.repositories) || !Array.isArray(repositories.repositories) ||
      !Array.isArray(workspaces.workspaces)) {
      throw new Error('Profile daemon returned an invalid recovery catalog')
    }
    return { lifecycle: lifecycle.repositories, repositories: repositories.repositories,
      workspaces: workspaces.workspaces }
  })
  ipcMain.handle('ade:restore-binding', async (_event, expectedProfile: unknown, kind: unknown, id: unknown, folder: unknown) => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    if (kind !== 'worktree' && kind !== 'repository' && kind !== 'workspace') throw new Error('Invalid recovery kind')
    if (!validId(id)) throw new Error('Invalid recovery identity')
    const endpoint = getSocket()
    const generation = getClientGeneration()
    const activeProfile = managedProfiles ? getProfileState().activeId : 'fixed'
    if (expectedProfile !== activeProfile) throw new Error('Profile changed while preparing workspace recovery')
    if (!endpoint || isSwitching() || isRestoringBinding() || getClient().getState().status !== 'connected') {
      throw new Error('Profile recovery is unavailable or already in progress')
    }
    setRestoringBinding(true)
    try {
      if (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096 || !(await stat(folder)).isDirectory()) {
        throw new Error('Choose an absolute folder path')
      }
      if (getSocket() !== endpoint || getClientGeneration() !== generation || getProfileState().activeId !== (managedProfiles ? activeProfile : null)) {
        throw new Error('Profile changed while checking the replacement folder')
      }
      const result = kind === 'worktree'
        ? await dailyUseCommand(endpoint, { op: 'worktree.rebind', repository_id: id, path: folder })
        : kind === 'repository'
          ? await dailyUseCommand(endpoint, { op: 'repository.rebind', repository_id: id, path: folder })
          : await dailyUseCommand(endpoint, { op: 'workspace.rebind', workspace_id: id, path: folder })
      if (getSocket() !== endpoint || getClientGeneration() !== generation) throw new Error('Profile changed during workspace recovery')
      return result
    } finally { setRestoringBinding(false) }
  })
  ipcMain.handle('ade:restore-choose-folder', async (event) => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    const endpoint = getSocket()
    const generation = getClientGeneration()
    if (!endpoint || isSwitching() || getClient().getState().status !== 'connected') throw new Error('Profile daemon is unavailable')
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose replacement folder', properties: ['openDirectory'], buttonLabel: 'Use this folder',
    }
    const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    if (getSocket() !== endpoint || getClientGeneration() !== generation || isSwitching()) throw new Error('Profile changed while choosing a replacement folder')
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('ade:workspace-select', async (event, workspaceId: unknown, conversationId: unknown) => {
    if (!validId(workspaceId) || (conversationId !== null && !validId(conversationId))) {
      throw new Error('Invalid selected workspace or conversation')
    }
    const endpoint = getSocket()
    const generation = getClientGeneration()
    const request = (selectionRequests.get(event.sender.id) ?? 0) + 1
    selectionRequests.set(event.sender.id, request)
    let available = false
    for (let attempt = 0; attempt < 120; attempt++) {
      if (getSocket() !== endpoint || getClientGeneration() !== generation) throw new Error('Profile changed while selecting a workspace')
      if (selectionRequests.get(event.sender.id) !== request) throw new Error('Workspace selection was superseded')
      const state = getClient().getState()
      available = state.status === 'connected' && Boolean(state.catalog?.workspaces.some((item) => item.id === workspaceId)) &&
        (conversationId === null || Boolean(state.catalog?.conversations.some((item) => item.id === conversationId && item.workspace_id === workspaceId)))
      if (available) break
      await new Promise<void>((done) => setTimeout(done, 25))
    }
    if (!available) throw new Error('Selected workspace or conversation is unavailable in this profile')
    if (selectionRequests.get(event.sender.id) !== request) throw new Error('Workspace selection was superseded')
    const prior = selectedWorkspaces.get(event.sender.id)
    if (prior?.workspaceId === workspaceId && prior.conversationId === conversationId && prior.generation === getClientGeneration()) return true
    selectedWorkspaces.set(event.sender.id, { workspaceId, conversationId: conversationId as string | null,
      generation: getClientGeneration(), epoch: (prior?.epoch ?? 0) + 1 })
    return true
  })
}
