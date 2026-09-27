import type { Conversation } from '@ade/client'

export type Frame = Record<string, unknown>
export type Message = { id: string; role: string; kind: string; text: string; status: string; sequence: number; content?: Frame }
export type PendingRequest = { id: string; method: string; params: Frame }
export type Snapshot = { conversation: Conversation; messages: Message[]; requests: PendingRequest[]; revision: number; boot_id: string }
export type Provider = { id: string; name: string }
type ClaudeIdentity = { auth_method: string; api_provider: string; email: string; org_id: string }
type CodexIdentity = { email: string; chatgpt_account_id: string }
type OmpIdentity = { provider: string; credential_id: number; credential_type: string;
  identity_key: string; email: string | null; account_id: string | null; org_id: string | null }
export type AccountIdentity = ClaudeIdentity | CodexIdentity | OmpIdentity
export type Account = { id: string; provider: string; name: string; native_home: string; generation: number; state: string;
  claude_identity?: ClaudeIdentity; codex_identity?: CodexIdentity; omp_identity?: OmpIdentity }
export type AccountInspection = { state: string; reason: string; version: string | null;
  identity: AccountIdentity | null }
export type AccountConversation = Conversation & { account_id?: string | null; account_context?: string }
export type PendingSend = { profileId: string; conversationId: string; requestId: string; text: string }
type Profile = { id: string; name: string; selected: boolean; home: string }
export type ProfileState = { managed: boolean; profiles: Profile[]; selectedId: string | null; activeId: string | null; error: string }
export type RestoreKind = 'worktree' | 'repository' | 'workspace'
export type RestoreEntry = { id: string; root: string; needs_rebind: boolean; rebindable?: boolean }
export type RestoreBindings = { lifecycle: RestoreEntry[]; repositories: RestoreEntry[];
  workspaces: Array<RestoreEntry & { name: string }> }
