import { createHash } from 'node:crypto'
import { formatReviewFeedback, requestDaemon, type ReviewFeedback } from '@ade/client'
import { CliError, jsonObject, namedOptions, object, required, type CommandResult } from '../shared.js'

export const gitUsage = `  git status WORKSPACE_ID                Read fresh Git status and revision tokens
  git diff WORKSPACE_ID PATH [--staged]  Read a file diff and its preview token
  git diff-page WORKSPACE_ID PATH SIDE [--cursor CURSOR --expected-token TOKEN]
                                        Page a large diff; SIDE is staged or unstaged
  git feedback-search WORKSPACE_ID [--path PATH] [--query TEXT] [--limit 1..50] [--before CURSOR]
                                        Search saved review notes by file or note text
  git feedback-send CONVERSATION_ID REQUEST_ID FEEDBACK_JSON
                                        Send structured anchored review notes once
  git stage WORKSPACE_ID PATH REVISION --request-id ID
  git unstage WORKSPACE_ID PATH REVISION --request-id ID
                                        Change exactly one reviewed file
  git discard WORKSPACE_ID PATH REVISION DIFF_TOKEN --request-id ID
                                        Discard one previewed unstaged change
  git commit WORKSPACE_ID MESSAGE INDEX_TOKEN --request-id ID
                                        Commit the reviewed staged index
  git operation WORKSPACE_ID REQUEST_ID  Inspect a Git operation receipt
`

function reviewSearchLimit(value: string): number {
  const number = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number) || number > 50) {
    throw new CliError('usage', 'LIMIT must be an integer from 1 to 50.')
  }
  return number
}

function reviewSearchCursor(value: string): number {
  const number = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new CliError('usage', 'CURSOR must be a positive integer returned by feedback-search.')
  }
  return number
}

function reviewFeedback(value: string | undefined): ReviewFeedback {
  const feedback = jsonObject(value, 'FEEDBACK_JSON')
  const keys = Object.keys(feedback)
  if (Buffer.byteLength(JSON.stringify(feedback)) > 64 * 1024 || keys.length !== 3 ||
    !keys.includes('format') || !keys.includes('workspace_id') || !keys.includes('notes') ||
    feedback.format !== 'ade-review-feedback-v1' ||
    typeof feedback.workspace_id !== 'string' || !feedback.workspace_id ||
    !Array.isArray(feedback.notes) || feedback.notes.length < 1 || feedback.notes.length > 16) {
    throw new CliError('usage', 'FEEDBACK_JSON must be bounded ade-review-feedback-v1 with 1 to 16 notes.')
  }
  for (const entry of feedback.notes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 || !('anchor' in entry) || !('note' in entry) ||
      typeof entry.note !== 'string' || !entry.note.trim() || Buffer.byteLength(entry.note) > 4096 ||
      !entry.anchor || typeof entry.anchor !== 'object' || Array.isArray(entry.anchor)) {
      throw new CliError('usage', 'Each review note needs an anchor and 1 to 4096 bytes of text.')
    }
    const anchor = entry.anchor as Record<string, unknown>
    if (Object.keys(anchor).some((key) => !['workspace_id', 'path', 'staged', 'revision', 'token',
      'hunk', 'line', 'text', 'end_line', 'end_text'].includes(key)) ||
      anchor.workspace_id !== feedback.workspace_id ||
      typeof anchor.path !== 'string' || !anchor.path ||
      typeof anchor.staged !== 'boolean' ||
      typeof anchor.revision !== 'string' || !/^[0-9a-f]{16}$/.test(anchor.revision) ||
      typeof anchor.token !== 'string' || !/^[0-9a-f]{16}$/.test(anchor.token) ||
      typeof anchor.hunk !== 'string' || !anchor.hunk.startsWith('@@ ') || anchor.hunk.length > 512 ||
      !Number.isSafeInteger(anchor.line) || (anchor.line as number) < 1 ||
      typeof anchor.text !== 'string' || Buffer.byteLength(anchor.text) > 8192 ||
      (anchor.end_line !== undefined || anchor.end_text !== undefined) &&
      (!Number.isSafeInteger(anchor.end_line) || (anchor.end_line as number) < (anchor.line as number) ||
        (anchor.end_line as number) - (anchor.line as number) >= 1000 ||
        typeof anchor.end_text !== 'string' || Buffer.byteLength(anchor.end_text) > 8192)) {
      throw new CliError('usage', 'Review anchors need a workspace, file, side, revision, token and selected line or range.')
    }
  }
  return feedback as ReviewFeedback
}

async function sendReviewFeedback(socketPath: string, conversationId: string,
  requestId: string, feedback: ReviewFeedback): Promise<Record<string, unknown>> {
  const text = formatReviewFeedback(feedback)
  // A request gets its own durable draft owner, separate from every GUI window.
  const windowId = `cli-review-${createHash('sha256').update(conversationId).update('\0')
    .update(requestId).digest('hex')}`
  const owner = { conversation_id: conversationId, window_id: windowId }
  const current = await requestDaemon(socketPath, 'draft.get', owner)
  const draft = object(current.draft)
  if (draft.revision === 0) {
    await requestDaemon(socketPath, 'draft.save', { ...owner, text, revision: 1 })
  }
  await requestDaemon(socketPath, 'draft.send.prepare', {
    ...owner, request_id: requestId, draft_text: text, revision: 1,
    text, review_feedback: feedback,
  })
  const response = await requestDaemon(socketPath, 'agent.send_review', {
    conversation_id: conversationId, request_id: requestId, text, review_feedback: feedback,
  })
  await requestDaemon(socketPath, 'draft.send.complete', { ...owner, request_id: requestId })
  return { ...response, request_id: requestId }
}

function gitMutationArgs(rest: string[], action: 'stage' | 'unstage' | 'commit' | 'discard'): {
  workspaceId: string; value: string; token: string; requestId: string; diffToken?: string
} {
  const flag = rest.length - 2
  const positionals = rest.slice(0, flag)
  if (positionals.length !== (action === 'discard' ? 4 : 3) || rest[flag] !== '--request-id' ||
    !rest[flag + 1] || rest[flag + 1].length > 256) {
    throw new CliError('usage', `git ${action} requires WORKSPACE_ID ${action === 'commit'
      ? 'MESSAGE INDEX_TOKEN' : action === 'discard' ? 'PATH REVISION DIFF_TOKEN' : 'PATH REVISION'} --request-id ID.`)
  }
  return {
    workspaceId: required(positionals[0], 'WORKSPACE_ID'),
    value: required(positionals[1], action === 'commit' ? 'MESSAGE' : 'PATH'),
    token: required(positionals[2], action === 'commit' ? 'INDEX_TOKEN' : 'REVISION'),
    requestId: rest[flag + 1],
    ...(action === 'discard' ? { diffToken: required(positionals[3], 'DIFF_TOKEN') } : {}),
  }
}

export async function runGitCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'git' && action === 'status') {
    if (rest.length !== 1) throw new CliError('usage', 'git status requires WORKSPACE_ID.')
    return requestDaemon(socketPath, 'review.status', { workspace_id: required(rest[0], 'WORKSPACE_ID'), force: true })
  }
  if (area === 'git' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'git operation requires WORKSPACE_ID REQUEST_ID.')
    return requestDaemon(socketPath, 'review.operation', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), request_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'git' && action === 'diff') {
    if (rest.length < 2 || rest.length > 3 || (rest.length === 3 && rest[2] !== '--staged')) {
      throw new CliError('usage', 'git diff requires WORKSPACE_ID PATH [--staged].')
    }
    return requestDaemon(socketPath, 'review.diff', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), path: required(rest[1], 'PATH'),
      staged: rest[2] === '--staged',
    })
  }
  if (area === 'git' && action === 'diff-page') {
    if (rest.length < 3 || !['staged', 'unstaged'].includes(rest[2])) {
      throw new CliError('usage', 'git diff-page requires WORKSPACE_ID PATH SIDE [--cursor CURSOR --expected-token TOKEN].')
    }
    const options = namedOptions(rest.slice(3), ['--cursor', '--expected-token'], 'git diff-page')
    if ((options['--cursor'] === undefined) !== (options['--expected-token'] === undefined)) {
      throw new CliError('usage', 'A continued diff page requires both --cursor and --expected-token.')
    }
    return requestDaemon(socketPath, 'review.diff_page', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), path: required(rest[1], 'PATH'),
      staged: rest[2] === 'staged',
      ...(options['--cursor'] === undefined ? {} : {
        cursor: options['--cursor'], expected_token: options['--expected-token'],
      }),
    })
  }
  if (area === 'git' && action === 'feedback-search') {
    if (rest.length < 1) throw new CliError('usage', 'git feedback-search requires WORKSPACE_ID and --path or --query.')
    const options = namedOptions(rest.slice(1), ['--path', '--query', '--limit', '--before'], 'git feedback-search')
    if (options['--path'] === undefined && options['--query'] === undefined) {
      throw new CliError('usage', 'git feedback-search requires --path or --query.')
    }
    if (options['--query'] !== undefined && !options['--query'].trim()) {
      throw new CliError('usage', 'QUERY cannot be blank.')
    }
    return requestDaemon(socketPath, 'review.feedback.search', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      ...(options['--path'] === undefined ? {} : { path: options['--path'] }),
      ...(options['--query'] === undefined ? {} : { query: options['--query'] }),
      ...(options['--limit'] === undefined ? {} : { limit: reviewSearchLimit(options['--limit']) }),
      ...(options['--before'] === undefined ? {} : { before: reviewSearchCursor(options['--before']) }),
    })
  }
  if (area === 'git' && action === 'feedback-send') {
    if (rest.length !== 3 || !rest[1] || rest[1].length > 256) {
      throw new CliError('usage', 'git feedback-send requires CONVERSATION_ID REQUEST_ID FEEDBACK_JSON.')
    }
    const feedback = reviewFeedback(rest[2])
    const requestId = required(rest[1], 'REQUEST_ID')
    return sendReviewFeedback(socketPath, required(rest[0], 'CONVERSATION_ID'), requestId, feedback)
  }
  if (area === 'git' && (action === 'stage' || action === 'unstage' || action === 'commit' || action === 'discard')) {
    const { workspaceId, value, token, requestId, diffToken } = gitMutationArgs(rest, action)
    const fields = action === 'commit'
      ? { message: value, index_token: token }
      : { path: value, revision: token, ...(action === 'discard' ? { diff_token: diffToken } : {}) }
    const response = await requestDaemon(socketPath, `review.${action}`, {
      workspace_id: workspaceId, request_id: requestId, ...fields,
    })
    return { ...response, workspace_id: workspaceId, request_id: requestId }
  }
  return undefined
}
