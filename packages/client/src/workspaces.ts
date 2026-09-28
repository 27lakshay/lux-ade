// What blocks `workspace.remove`, read from its `workspace_remove_blocked`
// error frame. The daemon's source is `ade_core::workspaces::RemoveBlocker`.
import { DaemonRequestError } from './request.js'

export type WorkspaceRemoveBlockerKind =
  | 'conversation_running'
  | 'conversation_in_terminal'
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
  if (!(error instanceof DaemonRequestError) || error.code !== 'workspace_remove_blocked') return []
  const listed = error.details.blockers
  if (!Array.isArray(listed)) return []
  return listed.flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return []
    const { kind, id, label } = item as Record<string, unknown>
    return typeof kind === 'string' && typeof id === 'string' && typeof label === 'string' ? [{ kind, id, label }] : []
  })
}
