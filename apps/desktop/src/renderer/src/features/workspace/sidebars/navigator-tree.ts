import type { CatalogProject, Conversation, Workspace } from '@ade/client'
import type { StatusState } from '@/components/Status'

// What the navigator lists: projects, their workspaces, and each workspace's conversations, all as
// the daemon's catalog states them (project, kind, branch, attention). Sorted by name, so the list
// does not jump as the catalog updates.

export interface NavigatorWorkspace {
  id: string
  name: string
  /** A folder's full path: where the workspace is on disk. */
  root: string
  branch: string | null
  /** The daemon's own workspace, which cannot be removed from ADE. */
  default: boolean
  /** A worktree ADE made and may delete. */
  deletableWorktree: boolean
  conversations: Conversation[]
}

export interface NavigatorProject {
  id: string
  name: string
  /** A Git repository, which can have worktrees; a plain folder cannot. */
  repository: boolean
  workspaces: NavigatorWorkspace[]
}

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/** Groups workspaces into their projects. */
export function navigatorTree(
  workspaces: Workspace[],
  conversations: Conversation[],
  projects: Record<string, CatalogProject>,
): NavigatorProject[] {
  const conversationsOf = new Map<string, Conversation[]>()
  for (const conversation of conversations) {
    const list = conversationsOf.get(conversation.workspace_id) ?? []
    list.push(conversation)
    conversationsOf.set(conversation.workspace_id, list)
  }
  const grouped = new Map<string, NavigatorProject>()
  for (const workspace of workspaces) {
    const projectId = workspace.project_id
    const project = projects[projectId]
    const group = grouped.get(projectId) ?? {
      id: projectId,
      name: project?.name ?? workspace.name,
      repository: project?.kind === 'repository',
      workspaces: [],
    }
    group.workspaces.push({
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      branch: workspace.branch,
      default: workspace.default,
      deletableWorktree: workspace.kind === 'linked_worktree' && workspace.ade_owned,
      conversations: conversationsOf.get(workspace.id) ?? [],
    })
    grouped.set(projectId, group)
  }
  return [...grouped.values()]
    .map((project) => ({ ...project, workspaces: [...project.workspaces].sort(byName) }))
    .sort(byName)
}

/** The status mark for what a conversation needs, as the daemon reports it. */
export function conversationState(conversation: Conversation): StatusState {
  switch (conversation.attention) {
    case 'running':
      return 'running'
    case 'needs_you':
      return 'needsYou'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}
