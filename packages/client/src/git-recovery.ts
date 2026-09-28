// Git mutations through the client's Git journal, for every client. A mutation is
// journaled before it is sent, so a lost admission reply can be retried with the
// same ID and parameters; the record leaves the journal once the daemon's receipt
// proves admission, or once the daemon provably refused it (`git-refusal.ts`).
// After admission the daemon's receipts own the operation.
import type { Response } from '@ade/contracts'
import { call } from './call.js'
import type { GitIntent, GitJournal } from './git-journal.js'
import { decideRefusedGitRecord, definiteRefusal, type RequestFailure } from './git-refusal.js'
import { decideGitAdmission, gitAdmitted, pendingGitOperation } from './outbox.js'
import { DaemonRequestError, isDaemonRefusal } from './request.js'

type ReviewOperationEntry = Response<'review.operation.list'>['operations'][number]
type GitMutation = GitIntent['op']

/** A Git write the daemon holds, named as a journal names one. */
export type DaemonGitIntent = {
  profile_id: string
  workspace_id: string
  op: ReviewOperationEntry['operation']['op']
  request_id: string
}

/** The Git write awaiting the person in a workspace, and those already acknowledged. */
export type GitJournalState = {
  pending: GitIntent | DaemonGitIntent | null
  archived: Array<{ intent: DaemonGitIntent; acknowledged_at: number | null }>
}

export type GitJournalAcknowledged = {
  type: 'git_journal_acknowledged'
  request_id: string
  status: ReviewOperationEntry['operation']['status']
}

/** Another Git operation in the workspace still needs the person; `blocking` is its request ID. */
export class GitOperationBlocked extends Error {
  constructor(
    message: string,
    readonly blocking: string,
  ) {
    super(message)
    this.name = 'GitOperationBlocked'
  }
}

/**
 * Checks the caller runs after each daemon reply, such as the desktop's check that
 * the window still shows the same profile and workspace. It throws to stop.
 */
type Check = () => void
const unchecked: Check = () => undefined

/** The workspace's daemon-owned Git operations that still need the person. */
async function listGitOperations(
  endpoint: string,
  workspaceId: string,
  includeAcknowledged = false,
): Promise<ReviewOperationEntry[]> {
  const response = await call(endpoint, 'review.operation.list', {
    workspace_id: workspaceId,
    ...(includeAcknowledged ? { include_acknowledged: true } : {}),
  })
  return response.operations
}

function requestFailure(error: unknown): RequestFailure | null {
  return error instanceof DaemonRequestError
    ? { code: error.code, delivery: error.delivery, message: error.message, refusal: isDaemonRefusal(error) }
    : null
}

/**
 * Release a Git mutation's journal record when the daemon definitely refused it
 * before admission: the send failed with a daemon answer, and the daemon then
 * neither knows nor lists the ID. Any doubt keeps the record for a retry.
 */
async function releaseRefusedGitRecord(
  journal: GitJournal,
  endpoint: string,
  intent: GitIntent,
  error: unknown,
): Promise<void> {
  const send = requestFailure(error)
  if (!definiteRefusal(send)) return
  let lookup: RequestFailure | null = null
  let settled = false
  try {
    const { operation } = await call(endpoint, 'review.operation', {
      workspace_id: intent.workspace_id,
      operation_id: intent.request_id,
    })
    settled = operation.id === intent.request_id && (operation.status === 'succeeded' || operation.status === 'failed')
  } catch (failure) {
    lookup = requestFailure(failure)
  }
  let listed: string[] | null = null
  try {
    listed = (await listGitOperations(endpoint, intent.workspace_id, true)).map((entry) => entry.operation.id)
  } catch {
    listed = null
  }
  if (decideRefusedGitRecord(intent.request_id, send, lookup, listed, settled) === 'release') {
    await journal.release(intent.profile_id, intent.workspace_id, intent.request_id)
  }
}

/** The request `intent` describes, as the daemon takes it. */
function gitRequest(intent: GitIntent): { op: GitMutation; fields: Record<string, unknown> } {
  const { profile_id: _profile, workspace_id, op, request_id, ...rest } = intent
  return { op, fields: { workspace_id, operation_id: request_id, ...rest } }
}

export type GitMutationOptions = {
  /** Runs after each daemon reply; see `Check`. */
  check?: Check
  /**
   * Also refuse while the daemon holds another operation of the workspace that
   * still needs the person (running, or interrupted and unacknowledged). The
   * desktop shows one such operation per workspace, so it asks the daemon first;
   * the CLI leaves that to the daemon and sends the mutation as its first request.
   */
  oneAtATime?: boolean
}

/**
 * Sends one Git mutation through the journal. The journal holds at most one
 * unadmitted mutation per workspace; another is refused with `GitOperationBlocked`
 * (and with `oneAtATime`, so is one while the daemon holds another that needs the
 * person). The record is durable before the request is sent.
 */
export async function sendGitMutation(
  journal: GitJournal,
  endpoint: string,
  intent: GitIntent,
  { check = unchecked, oneAtATime = true }: GitMutationOptions = {},
): Promise<Response<GitMutation>> {
  const workspaceId = intent.workspace_id
  check()
  const [local, listed] = await Promise.all([
    journal.pending(intent.profile_id, workspaceId),
    oneAtATime ? listGitOperations(endpoint, workspaceId) : [],
  ])
  check()
  const admission = decideGitAdmission(
    intent.request_id,
    local !== null && JSON.stringify(local) === JSON.stringify(intent),
    local,
    listed,
  )
  if (admission.kind === 'refuse') throw new GitOperationBlocked(admission.reason, admission.blocking)
  await journal.prepare(intent)
  check()
  const { op, fields } = gitRequest(intent)
  let response: Response<GitMutation>
  try {
    response = await call(endpoint, op, fields as never)
  } catch (error) {
    // A definite refusal before admission leaves no receipt, so the record
    // would otherwise block every later Git operation in the workspace.
    // A failed release keeps the record; the send failure is still what the caller sees.
    await releaseRefusedGitRecord(journal, endpoint, intent, error).catch(() => undefined)
    throw error
  }
  check()
  const receipt = response.operation
  if (
    response.type !== 'review_operation' ||
    !receipt ||
    typeof receipt !== 'object' ||
    receipt.id !== intent.request_id ||
    !['running', 'succeeded', 'failed', 'interrupted'].includes(String(receipt.status)) ||
    receipt.op !== intent.op
  ) {
    throw new Error('Invalid Git operation receipt')
  }
  // The receipt proves admission, so the daemon owns the operation from here.
  await journal.release(intent.profile_id, workspaceId, intent.request_id)
  return response
}

/**
 * The workspace's Git recovery view: `pending` is one operation that still needs
 * the person, and `archived` lists acknowledged interrupted ones. The journal
 * supplies only unadmitted records, and drops any the daemon now lists; the
 * daemon supplies everything it admitted.
 */
export async function readGitJournal(
  journal: GitJournal,
  endpoint: string,
  profileId: string,
  workspaceId: string,
  check: Check = unchecked,
): Promise<GitJournalState> {
  const [local, listed] = await Promise.all([
    journal.pending(profileId, workspaceId),
    listGitOperations(endpoint, workspaceId, true),
  ])
  check()
  let record = local
  if (local && gitAdmitted(local.request_id, listed)) {
    await journal.release(profileId, workspaceId, local.request_id)
    record = null
  }
  const pending = pendingGitOperation(record, listed)
  const daemonIntent = (entry: ReviewOperationEntry): DaemonGitIntent => ({
    profile_id: profileId,
    workspace_id: workspaceId,
    op: entry.operation.op,
    request_id: entry.operation.id,
  })
  return {
    pending: pending === null ? null : pending.source === 'local' ? pending.record : daemonIntent(pending.entry),
    archived: listed
      .filter((entry) => entry.acknowledged_at !== null)
      .map((entry) => ({ intent: daemonIntent(entry), acknowledged_at: entry.acknowledged_at })),
  }
}

/**
 * Settles one Git operation the person has seen: `settle` for one that finished,
 * `interrupted` for one the daemon interrupted, which the daemon then records as
 * acknowledged. A journal record left by a lost admission reply goes with it.
 */
export async function acknowledgeGitJournal(
  journal: GitJournal,
  endpoint: string,
  profileId: string,
  workspaceId: string,
  requestId: string,
  kind: 'settle' | 'interrupted',
  check: Check = unchecked,
): Promise<GitJournalAcknowledged> {
  const local = await journal.pending(profileId, workspaceId)
  if (local && local.request_id !== requestId) throw new Error('Git operation changed before acknowledgment')
  const response = await call(endpoint, 'review.operation', { workspace_id: workspaceId, operation_id: requestId })
  check()
  const operation = response.operation
  if (
    operation.id !== requestId ||
    (kind === 'settle' && operation.status !== 'succeeded' && operation.status !== 'failed') ||
    (kind === 'interrupted' && operation.status !== 'interrupted')
  ) {
    throw new Error('Git operation is not ready for acknowledgment')
  }
  if (kind === 'interrupted') {
    const acknowledged = await call(endpoint, 'review.operation.acknowledge', {
      workspace_id: workspaceId,
      operation_id: requestId,
    })
    if (acknowledged.operation.id !== requestId) throw new Error('Git acknowledgment did not match the operation')
  }
  await journal.release(profileId, workspaceId, requestId)
  check()
  return { type: 'git_journal_acknowledged', request_id: requestId, status: operation.status }
}
