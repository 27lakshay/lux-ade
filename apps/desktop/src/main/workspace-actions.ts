import { randomUUID } from 'node:crypto'
import { dailyUseCommand, settleWorktreeOperation, workspaceRemoveBlockers, worktreeDeleteBlockers } from '@ade/client'
import type { RemoveOutcome } from '../shared/bridge/workspaces'
import { handle } from './ipc'
import { getClient, getClientGeneration, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'
import { recordOf } from './windows'
import { blockerTexts } from './workspace-actions-core'

// The navigator's workspace actions, each one daemon command: rename, remove from ADE, create a
// worktree and delete one. Creating and deleting a worktree run on the daemon's worker; the SDK
// waits for the operation's final state on the feed.

/** The connected daemon; `still` throws if the profile changed since. */
function connection(): { endpoint: string; still: () => void } {
  const endpoint = getSocket()
  const generation = getClientGeneration()
  if (!endpoint || isSwitching() || getClient().getState().status !== 'connected')
    throw new Error('Profile daemon is unavailable')
  return {
    endpoint,
    still: () => {
      if (getSocket() !== endpoint || getClientGeneration() !== generation)
        throw new Error('Profile changed during the workspace action')
    },
  }
}

type WorktreeCommand =
  | { op: 'workspace.create_worktree'; operation_id: string; project_id: string; name: string; show_in?: string }
  | { op: 'workspace.delete_worktree'; operation_id: string; workspace_id: string }

/** How often main asks again while waiting, so a profile switch ends the wait. */
const RECHECK_MS = 5_000

/** Sends a worktree command and waits for its final state on the feed; a profile switch ends the wait. */
function settled(command: WorktreeCommand) {
  const { endpoint, still } = connection()
  return settleWorktreeOperation(
    getClient(),
    command.operation_id,
    async () => {
      still()
      return dailyUseCommand(endpoint, command)
    },
    { recheckMs: RECHECK_MS },
  )
}

export function registerWorkspaceActionIpc(): void {
  handle('ade:workspace-rename', async (_event, id: unknown, name: unknown) => {
    if (!validId(id)) throw new Error('Invalid workspace')
    await dailyUseCommand(connection().endpoint, { op: 'workspace.rename', workspace_id: id, name: String(name) })
  })

  handle('ade:workspace-remove', async (_event, id: unknown): Promise<RemoveOutcome> => {
    if (!validId(id)) throw new Error('Invalid workspace')
    try {
      await dailyUseCommand(connection().endpoint, {
        op: 'workspace.remove',
        workspace_id: id,
        operation_id: randomUUID(),
      })
      return { removed: true }
    } catch (error) {
      const blockers = workspaceRemoveBlockers(error)
      if (blockers.length === 0) throw error
      return { removed: false, reasons: blockerTexts(blockers) }
    }
  })

  // The daemon shows the new workspace in the asking window once it is ready (`show_in`).
  handle('ade:worktree-create', async (event, projectId: unknown, name: unknown) => {
    if (!validId(projectId)) throw new Error('Invalid project')
    const state = await settled({
      op: 'workspace.create_worktree',
      operation_id: randomUUID(),
      project_id: projectId,
      name: String(name),
      show_in: recordOf(event.sender.id),
    })
    if (state.status === 'failed' || !state.workspace_id)
      throw new Error(state.error ?? 'The worktree could not be created')
    return state.workspace_id
  })

  handle('ade:worktree-delete', async (_event, id: unknown): Promise<RemoveOutcome> => {
    if (!validId(id)) throw new Error('Invalid workspace')
    try {
      const state = await settled({ op: 'workspace.delete_worktree', operation_id: randomUUID(), workspace_id: id })
      if (state.status === 'failed') throw new Error(state.error ?? 'The worktree could not be deleted')
      return { removed: true }
    } catch (error) {
      const blockers = worktreeDeleteBlockers(error)
      if (blockers.length === 0) throw error
      return { removed: false, reasons: blockerTexts(blockers) }
    }
  })
}
