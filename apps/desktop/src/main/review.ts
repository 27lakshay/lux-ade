import { handle } from './ipc'
import {
  dailyUseCommand,
  formatReviewFeedback,
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
import { selectedWorkspaces } from './workspaces'

let gitJournal: GitJournal | null = null
export const setGitJournal = (value: GitJournal): void => {
  gitJournal = value
}
function gitRecovery(): GitJournal {
  if (!gitJournal) throw new Error('Git recovery journal is unavailable')
  return gitJournal
}
type ReviewStatus = DailyUseResponse<'review.status'>
type ReviewDiff = DailyUseResponse<'review.diff_page'>
function reviewPromptText(anchor: ReviewAnchor, note: string): string {
  return `Review feedback for workspace ${anchor.workspace_id}\nFile: ${anchor.path}\nSide: ${anchor.staged ? 'staged' : 'unstaged'}\nDiff token: ${anchor.token}\nStatus revision: ${anchor.revision}\nHunk: ${anchor.hunk}\nLine: +${anchor.line}\nSelected text: ${anchor.text}\n\nFeedback:\n${note.trim()}`
}
export function reviewNote(text: string, anchor: ReviewAnchor): string | null {
  const prefix = reviewPromptText(anchor, '')
  return text.startsWith(prefix) ? text.slice(prefix.length) : null
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
  const selection = selectedWorkspaces.get(senderId)
  if (!selection || selection.workspaceId !== workspaceId || selection.generation !== getClientGeneration()) {
    throw new Error('Selected workspace changed; return to Changes and try again')
  }
  return { endpoint, generation: getClientGeneration(), senderId, epoch: selection.epoch }
}

export function assertReviewContext(context: ReviewContext, workspaceId: string, conversationId?: string): void {
  const selection = selectedWorkspaces.get(context.senderId)
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

async function reviewStatus(context: ReviewContext, workspaceId: string): Promise<ReviewStatus> {
  const response = await dailyUseCommand<'review.status'>(context.endpoint, {
    op: 'review.status',
    workspace_id: workspaceId,
    force: true,
  })
  assertReviewContext(context, workspaceId)
  return response
}

async function reviewDiff(
  context: ReviewContext,
  workspaceId: string,
  path: string,
  staged: boolean,
): Promise<ReviewDiff> {
  const response = await dailyUseCommand<'review.diff_page'>(context.endpoint, {
    op: 'review.diff_page',
    workspace_id: workspaceId,
    path,
    staged,
  })
  assertReviewContext(context, workspaceId)
  return response
}

export async function reviewPrompt(
  context: ReviewContext,
  conversationId: string,
  value: unknown,
  note: unknown,
): Promise<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review anchor')
  const anchor = value as ReviewAnchor
  assertReviewContext(context, anchor.workspace_id, conversationId)
  const conversation = getClient()
    .getState()
    .catalog?.conversations.find((item) => item.id === conversationId)
  if (!conversation || conversation.workspace_id !== anchor.workspace_id)
    throw new Error('Review feedback must target a conversation in this workspace')
  if (
    !reviewPath(anchor.path) ||
    typeof anchor.staged !== 'boolean' ||
    typeof anchor.revision !== 'string' ||
    !/^[0-9a-f]{16}$/.test(anchor.revision) ||
    typeof anchor.token !== 'string' ||
    !/^[0-9a-f]{16}$/.test(anchor.token) ||
    typeof anchor.hunk !== 'string' ||
    !anchor.hunk.startsWith('@@ ') ||
    anchor.hunk.length > 512 ||
    !Number.isSafeInteger(anchor.line) ||
    anchor.line < 1 ||
    typeof anchor.text !== 'string' ||
    anchor.text.length > 8192 ||
    typeof note !== 'string' ||
    !note.trim() ||
    Buffer.byteLength(note) > 64 * 1024
  )
    throw new Error('Invalid review feedback')
  const status = await reviewStatus(context, anchor.workspace_id)
  if (status.revision !== anchor.revision)
    throw new Error('Stale diff: workspace changes have moved; refresh Changes and select the line again')
  if (!status.files.some((file) => file.path === anchor.path && (anchor.staged ? file.staged : file.unstaged))) {
    throw new Error('Stale diff: file or side changed; refresh Changes and select the line again')
  }
  const diff = await reviewDiff(context, anchor.workspace_id, anchor.path, anchor.staged)
  if (diff.token !== anchor.token) {
    throw new Error('Stale diff: selected line changed; refresh Changes and select the line again')
  }
  return reviewPromptText(anchor, note)
}

export async function reviewBatchPrompt(
  context: ReviewContext,
  conversationId: string,
  value: unknown,
): Promise<{ feedback: ReviewFeedback; text: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review feedback')
  const feedback = value as ReviewFeedback
  if (
    feedback.format !== 'ade-review-feedback-v1' ||
    !validId(feedback.workspace_id) ||
    !Array.isArray(feedback.notes) ||
    feedback.notes.length < 1 ||
    feedback.notes.length > 16 ||
    Buffer.byteLength(JSON.stringify(feedback)) > 64 * 1024
  )
    throw new Error('Invalid review feedback')
  assertReviewContext(context, feedback.workspace_id, conversationId)
  const conversation = getClient()
    .getState()
    .catalog?.conversations.find((item) => item.id === conversationId)
  if (!conversation || conversation.workspace_id !== feedback.workspace_id) {
    throw new Error('Review feedback must target a conversation in this workspace')
  }
  const status = await reviewStatus(context, feedback.workspace_id)
  const tokens = new Map<string, string>()
  for (const item of feedback.notes) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.note !== 'string' ||
      !item.note.trim() ||
      Buffer.byteLength(item.note) > 4096 ||
      !item.anchor ||
      typeof item.anchor !== 'object' ||
      Array.isArray(item.anchor)
    )
      throw new Error('Invalid review feedback')
    const anchor = item.anchor
    if (
      anchor.workspace_id !== feedback.workspace_id ||
      !reviewPath(anchor.path) ||
      typeof anchor.staged !== 'boolean' ||
      typeof anchor.revision !== 'string' ||
      !/^[0-9a-f]{16}$/.test(anchor.revision) ||
      typeof anchor.token !== 'string' ||
      !/^[0-9a-f]{16}$/.test(anchor.token) ||
      typeof anchor.hunk !== 'string' ||
      !anchor.hunk.startsWith('@@ ') ||
      anchor.hunk.length > 512 ||
      !Number.isSafeInteger(anchor.line) ||
      anchor.line < 1 ||
      typeof anchor.text !== 'string' ||
      anchor.text.length > 8192 ||
      ((anchor.end_line !== undefined || anchor.end_text !== undefined) &&
        (!Number.isSafeInteger(anchor.end_line) ||
          (anchor.end_line as number) < anchor.line ||
          typeof anchor.end_text !== 'string' ||
          anchor.end_text.length > 8192))
    )
      throw new Error('Invalid review feedback')
    if (
      status.revision !== anchor.revision ||
      !status.files.some((file) => file.path === anchor.path && (anchor.staged ? file.staged : file.unstaged))
    ) {
      throw new Error('Stale diff: workspace changes have moved; refresh Changes and select the ranges again')
    }
    const key = JSON.stringify([anchor.path, anchor.staged])
    let token = tokens.get(key)
    if (!token) {
      token = (await reviewDiff(context, feedback.workspace_id, anchor.path, anchor.staged)).token
      tokens.set(key, token)
    }
    if (token !== anchor.token)
      throw new Error('Stale diff: selected range changed; refresh Changes and select it again')
  }
  return { feedback, text: formatReviewFeedback(feedback) }
}

export function registerReviewIpc(): void {
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
