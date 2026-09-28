import type { Conversation, Workspace } from '@ade/client'
import type { StatusState } from '@/components/Status'

// What the navigator lists: projects, their workspaces, and each workspace's conversations. A
// project is a repository (its workspaces are its checkouts and worktrees) or a plain folder, which
// is a project with one workspace. Sorted by name, so the list does not jump as the catalog updates.

export interface NavigatorWorkspace {
  id: string
  name: string
  conversations: Conversation[]
}

export interface NavigatorProject {
  /** The repository id, or the workspace id for a plain folder. */
  id: string
  name: string
  workspaces: NavigatorWorkspace[]
}

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/**
 * Groups workspaces into projects. `projectNames` names repositories; without one, a repository
 * project takes the name of its first workspace.
 */
export function navigatorTree(
  workspaces: Workspace[],
  conversations: Conversation[],
  projectNames: Record<string, string> = {},
): NavigatorProject[] {
  const conversationsOf = new Map<string, Conversation[]>()
  for (const conversation of conversations) {
    const list = conversationsOf.get(conversation.workspace_id) ?? []
    list.push(conversation)
    conversationsOf.set(conversation.workspace_id, list)
  }
  const projects = new Map<string, NavigatorProject>()
  for (const workspace of workspaces) {
    const projectId = workspace.repository_id ?? workspace.id
    const project = projects.get(projectId) ?? { id: projectId, name: '', workspaces: [] }
    project.workspaces.push({
      id: workspace.id,
      name: workspace.name,
      conversations: conversationsOf.get(workspace.id) ?? [],
    })
    projects.set(projectId, project)
  }
  return [...projects.values()]
    .map((project) => {
      const sorted = [...project.workspaces].sort(byName)
      return { ...project, workspaces: sorted, name: projectNames[project.id] ?? sorted[0]!.name }
    })
    .sort(byName)
}

const RUNNING = new Set(['running', 'responding', 'streaming', 'starting', 'cancelling'])
const NEEDS_YOU = new Set(['waiting', 'pending'])
const FAILED = new Set(['error', 'unavailable', 'disconnected'])

/** The status mark for a conversation's status as the daemon reports it. */
export function conversationState(status: string): StatusState {
  if (RUNNING.has(status)) return 'running'
  if (NEEDS_YOU.has(status)) return 'needsYou'
  if (FAILED.has(status)) return 'error'
  return 'idle'
}
