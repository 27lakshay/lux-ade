import { createHash } from 'node:crypto'
import {
  call,
  dailyUseCommand,
  formatReviewFeedback,
  requestDaemon,
  type DailyUseRequest,
  type ReviewFeedback,
} from '@ade/client'
import {
  boundedInteger,
  CliError,
  jsonObject,
  namedOptions,
  parseWords,
  positionals,
  required,
  requestIdOption,
  type CommandResult,
} from '../shared.js'
import { decodeReply, type Fields } from './conversations.js'

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
  git hunk WORKSPACE_ID PATH DIFF_TOKEN HUNK --request-id ID [--unstage]
                                        Stage, or with --unstage unstage, one hunk of a previewed diff
  git operations WORKSPACE_ID [--all]   List running and unacknowledged interrupted Git mutations;
                                        --all adds acknowledged ones
  git acknowledge WORKSPACE_ID REQUEST_ID
                                        Record that you saw an interrupted mutation; it never runs again
  git branch WORKSPACE_ID NAME INDEX_TOKEN --request-id ID [--create] [--switch]
                                        Create a branch at HEAD, switch to one, or both
  git stash WORKSPACE_ID push|pop REVISION --request-id ID [--include-untracked] [--message TEXT]
                                        Save uncommitted changes, or apply and drop the newest stash
  git merge WORKSPACE_ID TARGET INDEX_TOKEN --request-id ID
                                        Merge a branch or commit; conflicts are listed in the receipt
  git merge-abort WORKSPACE_ID INDEX_TOKEN --request-id ID
                                        Abort a merge that stopped on conflicts
  git fetch WORKSPACE_ID --request-id ID [--remote NAME]
                                        Fetch a configured remote (the upstream's, else origin)
  git pull WORKSPACE_ID INDEX_TOKEN --request-id ID
                                        Fast-forward the current branch to its upstream
  git push WORKSPACE_ID INDEX_TOKEN --request-id ID [--remote NAME]
                                        Push the current branch without force; --remote sets a missing upstream
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
  if (
    Buffer.byteLength(JSON.stringify(feedback)) > 64 * 1024 ||
    keys.length !== 3 ||
    !keys.includes('format') ||
    !keys.includes('workspace_id') ||
    !keys.includes('notes') ||
    feedback.format !== 'ade-review-feedback-v1' ||
    typeof feedback.workspace_id !== 'string' ||
    !feedback.workspace_id ||
    !Array.isArray(feedback.notes) ||
    feedback.notes.length < 1 ||
    feedback.notes.length > 16
  ) {
    throw new CliError('usage', 'FEEDBACK_JSON must be bounded ade-review-feedback-v1 with 1 to 16 notes.')
  }
  for (const entry of feedback.notes) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !('anchor' in entry) ||
      !('note' in entry) ||
      typeof entry.note !== 'string' ||
      !entry.note.trim() ||
      Buffer.byteLength(entry.note) > 4096 ||
      !entry.anchor ||
      typeof entry.anchor !== 'object' ||
      Array.isArray(entry.anchor)
    ) {
      throw new CliError('usage', 'Each review note needs an anchor and 1 to 4096 bytes of text.')
    }
    const anchor = entry.anchor as Record<string, unknown>
    if (
      Object.keys(anchor).some(
        (key) =>
          ![
            'workspace_id',
            'path',
            'staged',
            'revision',
            'token',
            'hunk',
            'line',
            'text',
            'end_line',
            'end_text',
          ].includes(key),
      ) ||
      anchor.workspace_id !== feedback.workspace_id ||
      typeof anchor.path !== 'string' ||
      !anchor.path ||
      typeof anchor.staged !== 'boolean' ||
      typeof anchor.revision !== 'string' ||
      !/^[0-9a-f]{16}$/.test(anchor.revision) ||
      typeof anchor.token !== 'string' ||
      !/^[0-9a-f]{16}$/.test(anchor.token) ||
      typeof anchor.hunk !== 'string' ||
      !anchor.hunk.startsWith('@@ ') ||
      anchor.hunk.length > 512 ||
      !Number.isSafeInteger(anchor.line) ||
      (anchor.line as number) < 1 ||
      typeof anchor.text !== 'string' ||
      Buffer.byteLength(anchor.text) > 8192 ||
      ((anchor.end_line !== undefined || anchor.end_text !== undefined) &&
        (!Number.isSafeInteger(anchor.end_line) ||
          (anchor.end_line as number) < (anchor.line as number) ||
          (anchor.end_line as number) - (anchor.line as number) >= 1000 ||
          typeof anchor.end_text !== 'string' ||
          Buffer.byteLength(anchor.end_text) > 8192))
    ) {
      throw new CliError(
        'usage',
        'Review anchors need a workspace, file, side, revision, token and selected line or range.',
      )
    }
  }
  return feedback as ReviewFeedback
}

async function sendReviewFeedback(
  socketPath: string,
  conversationId: string,
  requestId: string,
  feedback: ReviewFeedback,
): Promise<Record<string, unknown>> {
  const text = formatReviewFeedback(feedback)
  // A request gets its own durable draft owner, separate from every GUI window.
  const windowId = `cli-review-${createHash('sha256')
    .update(conversationId)
    .update('\0')
    .update(requestId)
    .digest('hex')}`
  const owner: Fields<'draft.get'> = { conversation_id: conversationId, window_id: windowId }
  const { draft } = decodeReply('draft.get', await requestDaemon(socketPath, 'draft.get', owner))
  if (draft.revision === 0) {
    const save: Fields<'draft.save'> = { ...owner, text, revision: 1 }
    decodeReply('draft.save', await requestDaemon(socketPath, 'draft.save', save))
  }
  const prepare: Fields<'draft.send.prepare'> = {
    ...owner,
    request_id: requestId,
    draft_text: text,
    revision: 1,
    text,
    review_feedback: feedback,
  }
  decodeReply('draft.send.prepare', await requestDaemon(socketPath, 'draft.send.prepare', prepare))
  const response = await requestDaemon(socketPath, 'agent.send_review', {
    conversation_id: conversationId,
    request_id: requestId,
    text,
    review_feedback: feedback,
  })
  const complete: Fields<'draft.send.complete'> = { ...owner, request_id: requestId }
  decodeReply('draft.send.complete', await requestDaemon(socketPath, 'draft.send.complete', complete))
  return { ...response, request_id: requestId }
}

type GitMutation = 'review.stage' | 'review.unstage' | 'review.commit' | 'review.discard'

function gitMutationArgs(
  rest: string[],
  action: 'stage' | 'unstage' | 'commit' | 'discard',
): {
  workspaceId: string
  value: string
  token: string
  requestId: string
  diffToken?: string
} {
  const flag = rest.length - 2
  const positionals = rest.slice(0, flag)
  if (
    positionals.length !== (action === 'discard' ? 4 : 3) ||
    rest[flag] !== '--request-id' ||
    !rest[flag + 1] ||
    rest[flag + 1].length > 256
  ) {
    throw new CliError(
      'usage',
      `git ${action} requires WORKSPACE_ID ${
        action === 'commit'
          ? 'MESSAGE INDEX_TOKEN'
          : action === 'discard'
            ? 'PATH REVISION DIFF_TOKEN'
            : 'PATH REVISION'
      } --request-id ID.`,
    )
  }
  return {
    workspaceId: required(positionals[0], 'WORKSPACE_ID'),
    value: required(positionals[1], action === 'commit' ? 'MESSAGE' : 'PATH'),
    token: required(positionals[2], action === 'commit' ? 'INDEX_TOKEN' : 'REVISION'),
    requestId: rest[flag + 1],
    ...(action === 'discard' ? { diffToken: required(positionals[3], 'DIFF_TOKEN') } : {}),
  }
}

export async function runGitCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area === 'git' && action === 'status') {
    if (rest.length !== 1) throw new CliError('usage', 'git status requires WORKSPACE_ID.')
    return dailyUseCommand<'review.status'>(socketPath, {
      op: 'review.status',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      force: true,
    })
  }
  if (area === 'git' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'git operation requires WORKSPACE_ID REQUEST_ID.')
    return dailyUseCommand<'review.operation'>(socketPath, {
      op: 'review.operation',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      operation_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'git' && action === 'diff') {
    if (rest.length < 2 || rest.length > 3 || (rest.length === 3 && rest[2] !== '--staged')) {
      throw new CliError('usage', 'git diff requires WORKSPACE_ID PATH [--staged].')
    }
    return dailyUseCommand<'review.diff'>(socketPath, {
      op: 'review.diff',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      path: required(rest[1], 'PATH'),
      staged: rest[2] === '--staged',
    })
  }
  if (area === 'git' && action === 'diff-page') {
    if (rest.length < 3 || !['staged', 'unstaged'].includes(rest[2])) {
      throw new CliError(
        'usage',
        'git diff-page requires WORKSPACE_ID PATH SIDE [--cursor CURSOR --expected-token TOKEN].',
      )
    }
    const options = namedOptions(rest.slice(3), ['--cursor', '--expected-token'], 'git diff-page')
    if ((options['--cursor'] === undefined) !== (options['--expected-token'] === undefined)) {
      throw new CliError('usage', 'A continued diff page requires both --cursor and --expected-token.')
    }
    return dailyUseCommand<'review.diff_page'>(socketPath, {
      op: 'review.diff_page',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      path: required(rest[1], 'PATH'),
      staged: rest[2] === 'staged',
      ...(options['--cursor'] === undefined
        ? {}
        : {
            cursor: options['--cursor'],
            expected_token: options['--expected-token'],
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
    return dailyUseCommand<'review.feedback.search'>(socketPath, {
      op: 'review.feedback.search',
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
  if (area === 'git' && action === 'hunk') {
    const parsed = parseWords(rest, ['--request-id'], ['--unstage'], 'git hunk')
    const [workspace_id, path, token, hunk] = positionals(
      parsed,
      4,
      'git hunk requires WORKSPACE_ID PATH DIFF_TOKEN HUNK --request-id ID [--unstage]',
    )
    const operation_id = requestIdOption(parsed, 'git hunk')
    const response = await call(socketPath, 'review.hunk', {
      workspace_id,
      operation_id,
      path,
      token,
      hunk: boundedInteger(hunk, 'HUNK', 0, Number.MAX_SAFE_INTEGER),
      staged: parsed.flags.has('--unstage'),
    })
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && action === 'operations') {
    const parsed = parseWords(rest, [], ['--all'], 'git operations')
    const [workspace_id] = positionals(parsed, 1, 'git operations requires WORKSPACE_ID [--all]')
    return call(socketPath, 'review.operation.list', {
      workspace_id,
      ...(parsed.flags.has('--all') ? { include_acknowledged: true } : {}),
    })
  }
  if (area === 'git' && action === 'acknowledge') {
    const [workspace_id, operation_id] = positionals(
      parseWords(rest, [], [], 'git acknowledge'),
      2,
      'git acknowledge requires WORKSPACE_ID REQUEST_ID',
    )
    return call(socketPath, 'review.operation.acknowledge', { workspace_id, operation_id })
  }
  if (area === 'git' && action === 'branch') {
    const parsed = parseWords(rest, ['--request-id'], ['--create', '--switch'], 'git branch')
    const [workspace_id, name, index_token] = positionals(
      parsed,
      3,
      'git branch requires WORKSPACE_ID NAME INDEX_TOKEN --request-id ID [--create] [--switch]',
    )
    if (!parsed.flags.has('--create') && !parsed.flags.has('--switch')) {
      throw new CliError('usage', 'git branch requires --create, --switch or both.')
    }
    const operation_id = requestIdOption(parsed, 'git branch')
    const response = await call(socketPath, 'review.branch', {
      workspace_id,
      operation_id,
      name,
      index_token,
      ...(parsed.flags.has('--create') ? { create: true } : {}),
      ...(parsed.flags.has('--switch') ? { switch: true } : {}),
    })
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && action === 'stash') {
    const parsed = parseWords(rest, ['--request-id', '--message'], ['--include-untracked'], 'git stash')
    const [workspace_id, stashAction, revision] = positionals(
      parsed,
      3,
      'git stash requires WORKSPACE_ID push|pop REVISION --request-id ID',
    )
    if (stashAction !== 'push' && stashAction !== 'pop')
      throw new CliError('usage', 'git stash action must be push or pop.')
    const operation_id = requestIdOption(parsed, 'git stash')
    const response = await call(socketPath, 'review.stash', {
      workspace_id,
      operation_id,
      action: stashAction,
      revision,
      ...(parsed.flags.has('--include-untracked') ? { include_untracked: true } : {}),
      ...(parsed.options['--message'] === undefined ? {} : { message: parsed.options['--message'] }),
    })
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && (action === 'merge' || action === 'merge-abort')) {
    const parsed = parseWords(rest, ['--request-id'], [], `git ${action}`)
    const abort = action === 'merge-abort'
    const words = positionals(
      parsed,
      abort ? 2 : 3,
      abort
        ? 'git merge-abort requires WORKSPACE_ID INDEX_TOKEN --request-id ID'
        : 'git merge requires WORKSPACE_ID TARGET INDEX_TOKEN --request-id ID',
    )
    const workspace_id = words[0]
    const operation_id = requestIdOption(parsed, `git ${action}`)
    const response = await call(
      socketPath,
      'review.merge',
      abort
        ? { workspace_id, operation_id, action: 'abort', index_token: words[1] }
        : { workspace_id, operation_id, action: 'merge', target: words[1], index_token: words[2] },
    )
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && action === 'fetch') {
    const parsed = parseWords(rest, ['--request-id', '--remote'], [], 'git fetch')
    const [workspace_id] = positionals(parsed, 1, 'git fetch requires WORKSPACE_ID --request-id ID [--remote NAME]')
    const operation_id = requestIdOption(parsed, 'git fetch')
    const response = await call(socketPath, 'review.fetch', {
      workspace_id,
      operation_id,
      ...(parsed.options['--remote'] === undefined ? {} : { remote: parsed.options['--remote'] }),
    })
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && action === 'pull') {
    const parsed = parseWords(rest, ['--request-id'], [], 'git pull')
    const [workspace_id, index_token] = positionals(
      parsed,
      2,
      'git pull requires WORKSPACE_ID INDEX_TOKEN --request-id ID',
    )
    const operation_id = requestIdOption(parsed, 'git pull')
    const response = await call(socketPath, 'review.pull', { workspace_id, operation_id, index_token })
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && action === 'push') {
    const parsed = parseWords(rest, ['--request-id', '--remote'], [], 'git push')
    const [workspace_id, index_token] = positionals(
      parsed,
      2,
      'git push requires WORKSPACE_ID INDEX_TOKEN --request-id ID [--remote NAME]',
    )
    const operation_id = requestIdOption(parsed, 'git push')
    const response = await call(socketPath, 'review.push', {
      workspace_id,
      operation_id,
      index_token,
      ...(parsed.options['--remote'] === undefined ? {} : { remote: parsed.options['--remote'] }),
    })
    return { ...response, workspace_id, request_id: operation_id }
  }
  if (area === 'git' && (action === 'stage' || action === 'unstage' || action === 'commit' || action === 'discard')) {
    const { workspaceId, value, token, requestId, diffToken } = gitMutationArgs(rest, action)
    const target = { workspace_id: workspaceId, operation_id: requestId }
    const request: DailyUseRequest<GitMutation> =
      action === 'commit'
        ? { op: 'review.commit', ...target, message: value, index_token: token }
        : action === 'discard'
          ? {
              op: 'review.discard',
              ...target,
              path: value,
              revision: token,
              diff_token: required(diffToken, 'DIFF_TOKEN'),
            }
          : action === 'stage'
            ? { op: 'review.stage', ...target, path: value, revision: token }
            : { op: 'review.unstage', ...target, path: value, revision: token }
    const response = await dailyUseCommand<GitMutation>(socketPath, request)
    return { ...response, workspace_id: workspaceId, request_id: requestId }
  }
  return undefined
}
