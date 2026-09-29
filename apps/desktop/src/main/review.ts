import { randomUUID } from 'node:crypto'
import { handle } from './ipc'
import {
  dailyUseCommand,
  type DailyUseRequest,
  type DailyUseResponse,
  type ReviewAnchor,
  type ReviewFeedback,
} from '@ade/client'
import {
  acknowledgeGitJournal,
  readGitJournal,
  sendGitMutation,
  type GitIntent,
  type GitJournal,
} from '@ade/client/journals'
import { isAllowedOperation, reviewOperations } from '../shared/bridge/operations'
import { getClient, getClientGeneration, getSocket, journalProfileId } from './profile-connection'
import { validId } from './validation'
import { recordOf, selectedWorkspace } from './windows'

let gitJournal: GitJournal | null = null
export const setGitJournal = (value: GitJournal): void => {
  gitJournal = value
}
function gitRecovery(): GitJournal {
  if (!gitJournal) throw new Error('Git recovery journal is unavailable')
  return gitJournal
}
type ReviewContext = { endpoint: string; generation: number; senderId: number; epoch: number }

export function activeReviewContext(senderId: number, workspaceId: unknown): ReviewContext {
  const endpoint = getSocket()
  const state = getClient().getState()
  if (!endpoint || state.status !== 'connected') throw new Error('Profile daemon is unavailable')
  if (!validId(workspaceId) || !state.catalog?.workspaces.some((item) => item.id === workspaceId)) {
    throw new Error('Workspace is unavailable in this profile')
  }
  const selection = selectedWorkspace(senderId)
  if (!selection || selection.workspaceId !== workspaceId || selection.generation !== getClientGeneration()) {
    throw new Error('Selected workspace changed; return to Changes and try again')
  }
  return { endpoint, generation: getClientGeneration(), senderId, epoch: selection.epoch }
}

export function assertReviewContext(context: ReviewContext, workspaceId: string, conversationId?: string): void {
  const selection = selectedWorkspace(context.senderId)
  if (
    getSocket() !== context.endpoint ||
    getClientGeneration() !== context.generation ||
    !getClient()
      .getState()
      .catalog?.workspaces.some((item) => item.id === workspaceId) ||
    selection?.workspaceId !== workspaceId ||
    selection.generation !== context.generation ||
    selection.epoch !== context.epoch ||
    (conversationId !== undefined && selection.conversationId !== conversationId)
  ) {
    throw new Error('Profile, workspace, or conversation changed while review loaded; refresh Changes')
  }
}

/**
 * Sends review feedback to a Conversation in one daemon command. The daemon checks the anchors
 * are still current, builds the prompt and queues it; `window_id` makes it refuse while this
 * window's ordinary draft for the Conversation is not empty. The window's selected workspace
 * fences the request, as every review request is.
 */
async function sendFeedback(senderId: number, conversationId: unknown, feedback: unknown) {
  if (!validId(conversationId) || !feedback || typeof feedback !== 'object' || Array.isArray(feedback))
    throw new Error('Invalid review feedback')
  const fields = feedback as Record<string, unknown>
  const anchors = Array.isArray(fields.anchors) ? (fields.anchors as ReviewAnchor[]) : []
  const workspaceId = anchors[0]?.workspace_id ?? (fields.feedback as ReviewFeedback | undefined)?.workspace_id
  const context = activeReviewContext(senderId, workspaceId)
  const reply = await dailyUseCommand(context.endpoint, {
    op: 'review.feedback.send',
    operation_id: randomUUID(),
    conversation_id: conversationId,
    window_id: recordOf(senderId),
    ...(fields.feedback === undefined
      ? { anchors, note: typeof fields.note === 'string' ? fields.note : '' }
      : { feedback: fields.feedback as ReviewFeedback }),
  })
  assertReviewContext(context, workspaceId as string)
  return reply
}

export function registerReviewIpc(): void {
  handle('ade:review-feedback-send', (event, conversationId: unknown, feedback: unknown) =>
    sendFeedback(event.sender.id, conversationId, feedback),
  )
  // The daemon checks every field: a path outside the tree, a token Changes never showed, a file or
  // side that has no changes (`review_file_unavailable`). Main only fences the request to the
  // window's selected workspace and profile.
  handle('ade:review-request', async (event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(reviewOperations, op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid review request')
    }
    const args = fields as Record<string, unknown>
    const context = activeReviewContext(event.sender.id, args.workspace_id)
    const workspaceId = args.workspace_id as string
    const check = (): void => assertReviewContext(context, workspaceId)
    if (op === 'review.stage' || op === 'review.unstage' || op === 'review.commit' || op === 'review.discard') {
      const owner = {
        profile_id: journalProfileId(context.endpoint),
        workspace_id: workspaceId,
        request_id: args.request_id as string,
      }
      const intent: GitIntent =
        op === 'review.commit'
          ? { ...owner, op, message: args.message as string, index_token: args.index_token as string }
          : op === 'review.discard'
            ? {
                ...owner,
                op,
                path: args.path as string,
                revision: args.revision as string,
                diff_token: args.diff_token as string,
              }
            : { ...owner, op, path: args.path as string, revision: args.revision as string }
      return await sendGitMutation(gitRecovery(), context.endpoint, intent, { check })
    }
    let response: DailyUseResponse<typeof op>
    if (op === 'review.operation') {
      response = await dailyUseCommand<'review.operation'>(context.endpoint, {
        op,
        workspace_id: workspaceId,
        operation_id: args.request_id as string,
      })
    } else if (op === 'review.feedback.search') {
      response = await dailyUseCommand<'review.feedback.search'>(context.endpoint, {
        op,
        workspace_id: workspaceId,
        ...(args.path !== undefined ? { path: args.path as string } : {}),
        ...(args.query !== undefined ? { query: args.query as string } : {}),
        ...(args.before !== undefined ? { before: args.before as number } : {}),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
      })
    } else if (op === 'review.status') {
      response = await dailyUseCommand<'review.status'>(context.endpoint, {
        op,
        workspace_id: workspaceId,
        force: true,
      })
    } else {
      const side = { workspace_id: workspaceId, path: args.path as string, staged: args.staged as boolean }
      if (op === 'review.diff_page') {
        const page: DailyUseRequest<'review.diff_page'> = { op, ...side }
        if (args.cursor !== undefined) page.cursor = args.cursor as string
        if (args.expected_token !== undefined) page.expected_token = args.expected_token as string
        response = await dailyUseCommand<'review.diff_page'>(context.endpoint, page)
      } else {
        response = await dailyUseCommand<'review.diff'>(context.endpoint, { op: 'review.diff', ...side })
      }
    }
    check()
    return response
  })
  // The renderer's Git recovery view (`readGitJournal` in the SDK).
  handle('ade:git-journal-read', async (event, workspaceId: unknown) => {
    const context = activeReviewContext(event.sender.id, workspaceId)
    const workspace = workspaceId as string
    return readGitJournal(gitRecovery(), context.endpoint, journalProfileId(context.endpoint), workspace, () =>
      assertReviewContext(context, workspace),
    )
  })
  handle('ade:git-journal-ack', async (event, workspaceId: unknown, requestId: unknown, kind: unknown) => {
    const context = activeReviewContext(event.sender.id, workspaceId)
    if (
      typeof requestId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(requestId) ||
      (kind !== 'settle' && kind !== 'interrupted')
    )
      throw new Error('Invalid Git acknowledgment')
    const workspace = workspaceId as string
    return acknowledgeGitJournal(
      gitRecovery(),
      context.endpoint,
      journalProfileId(context.endpoint),
      workspace,
      requestId,
      kind,
      () => assertReviewContext(context, workspace),
    )
  })
}
