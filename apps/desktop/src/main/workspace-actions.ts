import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dailyUseCommand, workspaceRemoveBlockers } from '@ade/client'
import type { RemoveOutcome, WorktreeCheck } from '../shared/bridge/workspaces'
import { handle } from './ipc'
import { getClient, getClientGeneration, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'
import { workspaceBlockerText, worktreeBlockerTexts } from './workspace-actions-core'

// The navigator's workspace actions: rename, remove from ADE, create a worktree and delete one.
// Worktree commands take the lifecycle's own repository ID, which `worktree.repository` looks up
// from any checkout of the repository; a catalog `repository_id` is a different ID.

/** How long a worktree operation may run, setup hooks included, before main stops waiting. */
const OPERATION_TIMEOUT_MS = 15 * 60_000

/** The connected daemon and its generation; each step checks the profile has not changed since. */
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

function workspaceRoot(id: unknown): string {
  if (!validId(id)) throw new Error('Invalid workspace')
  const workspace = getClient()
    .getState()
    .catalog?.workspaces.find((item) => item.id === id)
  if (!workspace) throw new Error('The workspace is no longer open in ADE')
  return workspace.root
}

async function lifecycleRepository(endpoint: string, root: string): Promise<string> {
  const state = await dailyUseCommand(endpoint, { op: 'worktree.repository', path: root })
  return state.repository.id
}

/** Waits for a worktree operation to leave `running`, and throws unless it succeeded. */
async function settled(endpoint: string, still: () => void, repositoryId: string, operationId: string) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  for (;;) {
    still()
    const { operation } = await dailyUseCommand(endpoint, {
      op: 'worktree.operation',
      repository_id: repositoryId,
      operation_id: operationId,
    })
    if (operation.status === 'succeeded') return operation
    if (operation.status !== 'running') throw new Error(operation.error ?? `The worktree operation ${operation.status}`)
    if (Date.now() > deadline) throw new Error('The worktree operation is still running; check it again later')
    await new Promise<void>((done) => setTimeout(done, 250))
  }
}

async function removeWorkspace(endpoint: string, id: string): Promise<RemoveOutcome> {
  try {
    await dailyUseCommand(endpoint, { op: 'workspace.remove', workspace_id: id, operation_id: randomUUID() })
    return { removed: true }
  } catch (error) {
    const blockers = workspaceRemoveBlockers(error)
    if (blockers.length === 0) throw error
    return { removed: false, reasons: blockers.map(workspaceBlockerText) }
  }
}

async function checkWorktree(endpoint: string, root: string): Promise<WorktreeCheck & { repositoryId: string }> {
  const path = await realpath(root)
  const repositoryId = await lifecycleRepository(endpoint, root)
  const plan = await dailyUseCommand(endpoint, { op: 'worktree.cleanup.plan', repository_id: repositoryId })
  const candidates = await Promise.all(
    plan.trees.map(async (tree) => ({ tree, path: await realpath(tree.path).catch(() => tree.path) })),
  )
  const candidate = candidates.find((item) => item.path === path)?.tree
  return { path: candidate?.path ?? path, reasons: worktreeBlockerTexts(candidate), repositoryId }
}

export function registerWorkspaceActionIpc(): void {
  handle('ade:workspace-rename', async (_event, id: unknown, name: unknown) => {
    if (!validId(id)) throw new Error('Invalid workspace')
    // The daemon checks the name itself (empty, too long, control characters).
    if (typeof name !== 'string' || name.length > 1000) throw new Error('Invalid workspace name')
    await dailyUseCommand(connection().endpoint, { op: 'workspace.rename', workspace_id: id, name })
  })

  handle('ade:workspace-remove', async (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid workspace')
    return removeWorkspace(connection().endpoint, id)
  })

  handle('ade:worktree-create', async (_event, projectWorkspaceId: unknown, name: unknown) => {
    const root = workspaceRoot(projectWorkspaceId)
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Name the new workspace')
    const { endpoint, still } = connection()
    const repositoryId = await lifecycleRepository(endpoint, root)
    const operationId = randomUUID()
    await dailyUseCommand(endpoint, {
      op: 'worktree.create',
      repository_id: repositoryId,
      operation_id: operationId,
      name: name.trim(),
    })
    const operation = await settled(endpoint, still, repositoryId, operationId)
    if (!operation.worktree_path) throw new Error('The worktree was created without a folder')
    still()
    const { workspace } = await dailyUseCommand(endpoint, { op: 'workspace.open', path: operation.worktree_path })
    // The folder is named after the branch slug; ADE shows the name as typed.
    if (workspace.name !== name.trim())
      await dailyUseCommand(endpoint, { op: 'workspace.rename', workspace_id: workspace.id, name: name.trim() })
    return workspace.id
  })

  handle('ade:worktree-check', async (_event, id: unknown) => {
    const { path, reasons } = await checkWorktree(connection().endpoint, workspaceRoot(id))
    return { path, reasons }
  })

  handle('ade:worktree-delete', async (_event, id: unknown) => {
    const root = workspaceRoot(id)
    const { endpoint, still } = connection()
    const check = await checkWorktree(endpoint, root)
    if (check.reasons.length > 0) return { removed: false, reasons: check.reasons }
    const removed = await removeWorkspace(endpoint, id as string)
    if (!removed.removed) return removed
    still()
    const operationId = randomUUID()
    await dailyUseCommand(endpoint, {
      op: 'worktree.remove',
      repository_id: check.repositoryId,
      operation_id: operationId,
      path: check.path,
    })
    await settled(endpoint, still, check.repositoryId, operationId)
    return { removed: true }
  })
}
