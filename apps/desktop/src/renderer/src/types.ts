export type Frame = Record<string, unknown>
export type PendingSend = { profileId: string; conversationId: string; requestId: string; text: string }
type Profile = { id: string; name: string; selected: boolean; home: string }
export type ProfileState = {
  managed: boolean
  profiles: Profile[]
  selectedId: string | null
  activeId: string | null
  error: string
}
export type RestoreKind = 'worktree' | 'repository' | 'workspace'
type RestoreEntry = { id: string; root: string; needs_rebind: boolean; rebindable?: boolean }
export type RestoreBindings = {
  lifecycle: RestoreEntry[]
  repositories: RestoreEntry[]
  workspaces: Array<RestoreEntry & { name: string }>
}
