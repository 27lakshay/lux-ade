import type { DailyUseResponse } from '@ade/client'
import type { ContractRequest, ReviewOperation } from './operations'

type ReviewOperationRecord = DailyUseResponse<'review.operation'>['operation']

/** A Git write main journals before sending it, so a lost reply can be recovered. */
export type GitIntent = {
  profile_id: string
  workspace_id: string
  op: 'review.stage' | 'review.unstage' | 'review.commit' | 'review.discard'
  request_id: string
  path?: string
  revision?: string
  diff_token?: string
  index_token?: string
  message?: string
}

/** A Git write the daemon holds, named as main's journal names one. */
export type DaemonGitIntent = {
  profile_id: string
  workspace_id: string
  op: ReviewOperationRecord['op']
  request_id: string
}

/** The Git write awaiting the user in a workspace, and those already acknowledged. */
export type GitJournalState = {
  pending: GitIntent | DaemonGitIntent | null
  archived: Array<{ intent: DaemonGitIntent; acknowledged_at: number | null }>
}

export type GitJournalAcknowledged = {
  type: 'git_journal_acknowledged'
  request_id: string
  status: ReviewOperationRecord['status']
}

/** `window.adeHost.review`: the main-process `review` module and its git intent journal. */
export interface ReviewBridge {
  request: ContractRequest<ReviewOperation>
  readGitJournal(workspaceId: string): Promise<GitJournalState>
  acknowledgeGitJournal(
    workspaceId: string,
    requestId: string,
    kind: 'settle' | 'interrupted',
  ): Promise<GitJournalAcknowledged>
}
