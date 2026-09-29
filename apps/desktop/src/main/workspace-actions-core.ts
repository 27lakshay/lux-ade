// What stops a workspace or its worktree from being removed, in words the navigator shows. The
// daemon names each blocker by kind, with a label: `workspace.remove` in its
// `workspace_remove_blocked` refusal, `workspace.delete_worktree` in `worktree_delete_blocked`
// (the workspace's blockers and the tree's cleanup blockers in one list).

/** A blocker as the SDK reads it from a refusal. */
export type Blocker = { kind: string; id: string; label: string }

const treeReasons: Record<string, string> = {
  primary_checkout: 'It is the project’s main checkout',
  not_a_worktree: 'It is a plain folder, not a worktree',
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
  active_work: 'Something ADE runs is still using it',
}

/** One reason a removal was refused. */
export function blockerText({ kind, label }: Blocker): string {
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
      return treeReasons[kind] ?? label
  }
}

/** Each reason once, in the order the daemon listed them. */
export const blockerTexts = (blockers: Blocker[]): string[] => [...new Set(blockers.map(blockerText))]
