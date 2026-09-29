// What blocks `workspace.remove`, read from its `workspace_remove_blocked`
// error frame. The daemon's source is `ade_core::workspaces::RemoveBlocker`.
import type { FeedFrame, Response } from '@ade/contracts'
import { DaemonRequestError } from './request.js'

export type WorkspaceRemoveBlockerKind =
  | 'conversation_running'
  | 'service_running'
  | 'script_running'
  | 'default_workspace'

/** One thing to stop before the workspace can be removed. */
export interface WorkspaceRemoveBlocker {
  kind: WorkspaceRemoveBlockerKind | (string & {})
  /** The Conversation, service, script run or workspace ID. */
  id: string
  /** A label a person recognises, such as `Service web`. */
  label: string
}

/** The blockers a `workspace_remove_blocked` refusal lists; empty for any other error. */
export function workspaceRemoveBlockers(error: unknown): WorkspaceRemoveBlocker[] {
  return blockers(error, 'workspace_remove_blocked')
}

/**
 * What blocks `workspace.delete_worktree`: a `workspace.remove` blocker, a
 * `worktree.cleanup.plan` blocker of the tree (such as `dirty`,
 * `primary_checkout` or `external`), or `not_a_worktree` for a plain folder.
 * The daemon's source is `ade_core::workspaces::DeleteBlocker`.
 */
export interface WorktreeDeleteBlocker {
  kind: string
  /** The Conversation, service, script run or workspace ID, or the tree's path. */
  id: string
  label: string
}

/** The blockers a `worktree_delete_blocked` refusal lists; empty for any other error. */
export function worktreeDeleteBlockers(error: unknown): WorktreeDeleteBlocker[] {
  return blockers(error, 'worktree_delete_blocked')
}

function blockers(error: unknown, code: string): WorkspaceRemoveBlocker[] {
  if (!(error instanceof DaemonRequestError) || error.code !== code) return []
  const listed = error.details.blockers
  if (!Array.isArray(listed)) return []
  return listed.flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return []
    const { kind, id, label } = item as Record<string, unknown>
    return typeof kind === 'string' && typeof id === 'string' && typeof label === 'string' ? [{ kind, id, label }] : []
  })
}

/** A `workspace.create_worktree` or `workspace.delete_worktree` operation's state. */
export type WorkspaceWorktreeState = Response<'workspace.create_worktree'>

/** What `settleWorktreeOperation` watches: a client's connection state and feed. */
export interface WorktreeOperationFeed {
  subscribe(listener: (state: { status: string }) => void): () => void
  subscribeFeed(listener: (frame: FeedFrame) => void): () => void
}

/**
 * Waits for a workspace worktree operation to leave `running`. `send` sends
 * its command under the operation's ID; its reply is the state now. The state
 * that settles it comes from that reply or from the operation's
 * `workspace_worktree_operation_changed` frame. After the connection drops
 * and returns, frames may have been missed, so `send` runs again. A `send`
 * that throws ends the wait with its error.
 *
 * `recheckMs` also runs `send` at that interval, a safety net for a client
 * that stops without saying so (Electron main replacing it on a profile
 * switch, where `send` then throws).
 */
export function settleWorktreeOperation(
  feed: WorktreeOperationFeed,
  operationId: string,
  send: () => Promise<WorkspaceWorktreeState>,
  options: { recheckMs?: number } = {},
): Promise<WorkspaceWorktreeState> {
  return new Promise((resolve, reject) => {
    const stops: (() => void)[] = []
    let done = false
    let asking = false
    const end = (): void => {
      done = true
      for (const stop of stops.splice(0)) stop()
    }
    const settle = (state: WorkspaceWorktreeState): void => {
      if (done || state.operation_id !== operationId || state.status === 'running') return
      end()
      resolve(state)
    }
    const ask = (): void => {
      if (asking) return
      asking = true
      send()
        .then(settle, (error: unknown) => {
          if (done) return
          end()
          reject(error)
        })
        .finally(() => {
          asking = false
        })
    }
    if (options.recheckMs) {
      const timer = setInterval(ask, options.recheckMs)
      stops.push(() => clearInterval(timer))
    }
    stops.push(
      feed.subscribeFeed((frame) => {
        if (frame.type === 'workspace_worktree_operation_changed') settle(frame.operation)
      }),
    )
    let connected: boolean | null = null
    stops.push(
      feed.subscribe(({ status }) => {
        const now = status === 'connected'
        if (connected === false && now && !done) ask()
        connected = now
      }),
    )
    ask()
  })
}
