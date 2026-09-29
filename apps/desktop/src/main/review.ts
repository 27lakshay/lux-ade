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
export function reviewPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
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

async function reviewStatus(context: ReviewContext, workspaceId: string): Promise<DailyUseResponse<'review.status'>> {
  const response = await dailyUseCommand<'review.status'>(context.endpoint, {
    op: 'review.status',
    workspace_id: workspaceId,
    force: true,
  })
  assertReviewContext(context, workspaceId)
  return response
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
  handle('ade:review-request', async (event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(reviewOperations, op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid review request')
    }
    const args = fields as Record<string, unknown>
    const context = activeReviewContext(event.sender.id, args.workspace_id)
    const workspaceId = args.workspace_id as string
    if (op === 'review.feedback.search') {
      if (
        (args.path !== undefined && !reviewPath(args.path)) ||
        (args.query !== undefined &&
          (typeof args.query !== 'string' || !args.query.trim() || Buffer.byteLength(args.query) > 256)) ||
        (args.path === undefined && args.query === undefined) ||
        (args.before !== undefined && (!Number.isSafeInteger(args.before) || (args.before as number) < 1)) ||
        (args.limit !== undefined &&
          (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 50))
      ) {
        throw new Error('Invalid review feedback search')
      }
      const response = await dailyUseCommand<'review.feedback.search'>(context.endpoint, {
        op,
        workspace_id: workspaceId,
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.before !== undefined ? { before: args.before as number } : {}),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
      })
      assertReviewContext(context, workspaceId)
      return response
    }
    if (
      op === 'review.operation' ||
      op === 'review.stage' ||
      op === 'review.unstage' ||
      op === 'review.commit' ||
      op === 'review.discard'
    ) {
      if (typeof args.request_id !== 'string' || !/^[0-9a-f-]{36}$/.test(args.request_id)) {
        throw new Error('Invalid Git operation ID')
      }
      const requestId = args.request_id
      const check = (): void => assertReviewContext(context, workspaceId)
      if (op === 'review.operation') {
        const response = await dailyUseCommand<'review.operation'>(context.endpoint, {
          op,
          workspace_id: workspaceId,
          operation_id: requestId,
        })
        check()
        if (
          response.type !== 'review_operation' ||
          response.operation?.id !== requestId ||
          !['running', 'succeeded', 'failed', 'interrupted'].includes(String(response.operation.status))
        ) {
          throw new Error('Invalid Git operation receipt')
        }
        return response
      }
      const owner = { profile_id: journalProfileId(context.endpoint), workspace_id: workspaceId, request_id: requestId }
      let intent: GitIntent
      if (op === 'review.stage' || op === 'review.unstage' || op === 'review.discard') {
        if (!reviewPath(args.path) || typeof args.revision !== 'string' || !/^[0-9a-f]{16}$/.test(args.revision)) {
          throw new Error('Invalid Git file revision')
        }
        const file = { path: args.path, revision: args.revision }
        if (op === 'review.discard') {
          if (typeof args.diff_token !== 'string' || !/^[0-9a-f]{16}$/.test(args.diff_token)) {
            throw new Error('Invalid Git discard preview token')
          }
          intent = { ...owner, op, ...file, diff_token: args.diff_token }
        } else {
          intent = { ...owner, op, ...file }
        }
      } else {
        if (
          typeof args.message !== 'string' ||
          !args.message.trim() ||
          Buffer.byteLength(args.message) > 64 * 1024 ||
          typeof args.index_token !== 'string' ||
          !/^[0-9a-f]{16}$/.test(args.index_token)
        ) {
          throw new Error('Invalid Git commit request')
        }
        intent = { ...owner, op, message: args.message, index_token: args.index_token }
      }
      return await sendGitMutation(gitRecovery(), context.endpoint, intent, { check })
    }
    const status = await reviewStatus(context, workspaceId)
    if (op === 'review.status') return status
    if (
      !reviewPath(args.path) ||
      typeof args.staged !== 'boolean' ||
      !status.files.some((file) => file.path === args.path && (args.staged ? file.staged : file.unstaged))
    ) {
      throw new Error('File or side is unavailable in this workspace; refresh Changes')
    }
    const side = { workspace_id: workspaceId, path: args.path, staged: args.staged }
    if (op === 'review.diff_page') {
      const page: DailyUseRequest<'review.diff_page'> = { op, ...side }
      if (args.cursor !== undefined) {
        if (!validId(args.cursor)) throw new Error('Invalid diff cursor')
        page.cursor = args.cursor
      }
      if (args.expected_token !== undefined) {
        if (typeof args.expected_token !== 'string' || !/^[0-9a-f]{16}$/.test(args.expected_token)) {
          throw new Error('Invalid expected diff token')
        }
        page.expected_token = args.expected_token
      }
      const response = await dailyUseCommand<'review.diff_page'>(context.endpoint, page)
      assertReviewContext(context, workspaceId)
      return response
    }
    const response = await dailyUseCommand<'review.diff'>(context.endpoint, { op: 'review.diff', ...side })
    assertReviewContext(context, workspaceId)
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
