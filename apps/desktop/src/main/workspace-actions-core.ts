// What stops a workspace or its worktree from being removed, in words the navigator shows. The
// daemon names each blocker by kind: `workspace.remove` in its `workspace_remove_blocked` refusal,
// `worktree.cleanup.plan` for each linked tree.

/** A `workspace.remove` blocker, as `workspaceRemoveBlockers` reads it. */
export type WorkspaceBlocker = { kind: string; id: string; label: string }

/** One reason `workspace.remove` refused. */
export function workspaceBlockerText({ kind, label }: WorkspaceBlocker): string {
  switch (kind) {
    case 'conversation_running':
      return `“${label}” is running`
    case 'conversation_in_terminal':
      return `“${label}” is open in a terminal`
    case 'service_running':
    case 'script_running':
      return `${label} is running`
    case 'default_workspace':
      return 'ADE keeps this workspace for itself'
    default:
      return label
  }
}

const worktreeReasons: Record<string, string | null> = {
  // Removing the workspace from ADE first ends its terminals and Agents.
  active_work: null,
  // `worktree.remove` is the stated recovery for both.
  setup_incomplete: null,
  teardown_incomplete: null,
  primary_checkout: 'It is the project’s main checkout',
  external: 'ADE did not create this worktree',
  authority_changed: 'Its ADE ownership marker has changed',
  locked: 'Git has locked it',
  unavailable: 'Git no longer lists it',
  not_listed: 'Git no longer lists it',
  dirty: 'It has uncommitted or untracked files',
  status_unknown: 'Git could not read its status',
  claim_held: 'Another process is using it',
  claim_uncertain: 'Another process may be using it',
  registry_unavailable: 'ADE cannot confirm nothing else is using it',
  lifecycle_running: 'Another worktree operation is running in this project',
}

/**
 * Why a workspace's worktree cannot be deleted, from its `worktree.cleanup.plan` candidate; empty
 * when it can. A tree missing from the plan is the primary checkout, which the plan leaves out.
 */
export function worktreeBlockerTexts(candidate: { blockers: string[] } | undefined): string[] {
  if (!candidate) return [worktreeReasons.primary_checkout!]
  const texts = candidate.blockers.map((blocker) =>
    blocker in worktreeReasons ? worktreeReasons[blocker] : `Blocked: ${blocker.replaceAll('_', ' ')}`,
  )
  return [...new Set(texts.filter((text): text is string => text !== null))]
}
