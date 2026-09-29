import { call, dailyUseCommand } from '@ade/client'
import { GitOperationBlocked, readGitJournal, sendGitMutation, type GitIntent } from '@ade/client/journals'
import {
  boundedInteger,
  CliError,
  namedOptions,
  parseWords,
  positionals,
  required,
  requiredOperationId,
  withJournals,
  type CommandResult,
} from '../shared.js'
import { journalFailure } from './conversations.js'

export const gitUsage = `  git status WORKSPACE_ID                Read fresh Git status and revision tokens
  git diff WORKSPACE_ID PATH [--staged]
                                        Read a file diff and its preview token
  git diff-page WORKSPACE_ID PATH SIDE [--cursor CURSOR --expected-token TOKEN]
                                        Page a large diff; SIDE is staged or unstaged
  git feedback-search WORKSPACE_ID [--path PATH] [--query TEXT] [--limit 1..50] [--before CURSOR]
                                        Search saved review notes by file or note text
  git stage WORKSPACE_ID PATH REVISION --operation-id ID
  git unstage WORKSPACE_ID PATH REVISION --operation-id ID
                                        Change exactly one reviewed file
  git discard WORKSPACE_ID PATH REVISION DIFF_TOKEN --operation-id ID
                                        Discard one previewed unstaged change
  git commit WORKSPACE_ID MESSAGE INDEX_TOKEN --operation-id ID
                                        Commit the reviewed staged index
  git operation WORKSPACE_ID OPERATION_ID
                                        Inspect a Git operation receipt
  git recovery WORKSPACE_ID             Show the stage, unstage, commit or discard that still needs you:
                                        one held in the client journal, or one the daemon holds
  git hunk WORKSPACE_ID PATH DIFF_TOKEN HUNK --operation-id ID [--unstage]
                                        Stage, or with --unstage unstage, one hunk of a previewed diff
  git operations WORKSPACE_ID [--all]   List running and unacknowledged interrupted Git mutations;
                                        --all adds acknowledged ones
  git acknowledge WORKSPACE_ID OPERATION_ID
                                        Record that you saw an interrupted mutation; it never runs again
  git branch WORKSPACE_ID NAME INDEX_TOKEN --operation-id ID [--create] [--switch]
                                        Create a branch at HEAD, switch to one, or both
  git stash WORKSPACE_ID push|pop REVISION --operation-id ID [--include-untracked] [--message TEXT]
                                        Save uncommitted changes, or apply and drop the newest stash
  git merge WORKSPACE_ID TARGET INDEX_TOKEN --operation-id ID
                                        Merge a branch or commit; conflicts are listed in the receipt
  git merge-abort WORKSPACE_ID INDEX_TOKEN --operation-id ID
                                        Abort a merge that stopped on conflicts
  git fetch WORKSPACE_ID --operation-id ID [--remote NAME]
                                        Fetch a configured remote (the upstream's, else origin)
  git pull WORKSPACE_ID INDEX_TOKEN --operation-id ID
                                        Fast-forward the current branch to its upstream
  git push WORKSPACE_ID INDEX_TOKEN --operation-id ID [--remote NAME]
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

/** A Git mutation through the client journal; a blocking operation names its request ID. */
function gitJournalFailure<T>(work: () => Promise<T>): Promise<T> {
  return journalFailure(async () => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof GitOperationBlocked) {
        throw new CliError('conflict', `${error.message}: finish or acknowledge request ${error.blocking} first.`)
      }
      throw error
    }
  })
}

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
  const positionals = rest
  if (positionals.length !== (action === 'discard' ? 4 : 3)) {
    throw new CliError(
      'usage',
      `git ${action} requires WORKSPACE_ID ${
        action === 'commit'
          ? 'MESSAGE INDEX_TOKEN'
          : action === 'discard'
            ? 'PATH REVISION DIFF_TOKEN'
            : 'PATH REVISION'
      } --operation-id ID.`,
    )
  }
  return {
    workspaceId: required(positionals[0], 'WORKSPACE_ID'),
    value: required(positionals[1], action === 'commit' ? 'MESSAGE' : 'PATH'),
    token: required(positionals[2], action === 'commit' ? 'INDEX_TOKEN' : 'REVISION'),
    requestId: requiredOperationId(),
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
    if (rest.length !== 2) throw new CliError('usage', 'git operation requires WORKSPACE_ID OPERATION_ID.')
    return dailyUseCommand<'review.operation'>(socketPath, {
      op: 'review.operation',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      operation_id: required(rest[1], 'OPERATION_ID'),
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
  if (area === 'git' && action === 'hunk') {
    const parsed = parseWords(rest, [], ['--unstage'], 'git hunk')
    const [workspace_id, path, token, hunk] = positionals(
      parsed,
      4,
      'git hunk requires WORKSPACE_ID PATH DIFF_TOKEN HUNK --operation-id ID [--unstage]',
    )
    const operation_id = requiredOperationId()
    const response = await call(socketPath, 'review.hunk', {
      workspace_id,
      operation_id,
      path,
      token,
      hunk: boundedInteger(hunk, 'HUNK', 0, Number.MAX_SAFE_INTEGER),
      staged: parsed.flags.has('--unstage'),
    })
    return { ...response, workspace_id, operation_id }
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
      'git acknowledge requires WORKSPACE_ID OPERATION_ID',
    )
    return call(socketPath, 'review.operation.acknowledge', { workspace_id, operation_id })
  }
  if (area === 'git' && action === 'branch') {
    const parsed = parseWords(rest, [], ['--create', '--switch'], 'git branch')
    const [workspace_id, name, index_token] = positionals(
      parsed,
      3,
      'git branch requires WORKSPACE_ID NAME INDEX_TOKEN --operation-id ID [--create] [--switch]',
    )
    if (!parsed.flags.has('--create') && !parsed.flags.has('--switch')) {
      throw new CliError('usage', 'git branch requires --create, --switch or both.')
    }
    const operation_id = requiredOperationId()
    const response = await call(socketPath, 'review.branch', {
      workspace_id,
      operation_id,
      name,
      index_token,
      ...(parsed.flags.has('--create') ? { create: true } : {}),
      ...(parsed.flags.has('--switch') ? { switch: true } : {}),
    })
    return { ...response, workspace_id, operation_id }
  }
  if (area === 'git' && action === 'stash') {
    const parsed = parseWords(rest, ['--message'], ['--include-untracked'], 'git stash')
    const [workspace_id, stashAction, revision] = positionals(
      parsed,
      3,
      'git stash requires WORKSPACE_ID push|pop REVISION --operation-id ID',
    )
    if (stashAction !== 'push' && stashAction !== 'pop')
      throw new CliError('usage', 'git stash action must be push or pop.')
    const operation_id = requiredOperationId()
    const response = await call(socketPath, 'review.stash', {
      workspace_id,
      operation_id,
      action: stashAction,
      revision,
      ...(parsed.flags.has('--include-untracked') ? { include_untracked: true } : {}),
      ...(parsed.options['--message'] === undefined ? {} : { message: parsed.options['--message'] }),
    })
    return { ...response, workspace_id, operation_id }
  }
  if (area === 'git' && (action === 'merge' || action === 'merge-abort')) {
    const parsed = parseWords(rest, [], [], `git ${action}`)
    const abort = action === 'merge-abort'
    const words = positionals(
      parsed,
      abort ? 2 : 3,
      abort
        ? 'git merge-abort requires WORKSPACE_ID INDEX_TOKEN --operation-id ID'
        : 'git merge requires WORKSPACE_ID TARGET INDEX_TOKEN --operation-id ID',
    )
    const workspace_id = words[0]
    const operation_id = requiredOperationId()
    const response = await call(
      socketPath,
      'review.merge',
      abort
        ? { workspace_id, operation_id, action: 'abort', index_token: words[1] }
        : { workspace_id, operation_id, action: 'merge', target: words[1], index_token: words[2] },
    )
    return { ...response, workspace_id, operation_id }
  }
  if (area === 'git' && action === 'fetch') {
    const parsed = parseWords(rest, ['--remote'], [], 'git fetch')
    const [workspace_id] = positionals(parsed, 1, 'git fetch requires WORKSPACE_ID --operation-id ID [--remote NAME]')
    const operation_id = requiredOperationId()
    const response = await call(socketPath, 'review.fetch', {
      workspace_id,
      operation_id,
      ...(parsed.options['--remote'] === undefined ? {} : { remote: parsed.options['--remote'] }),
    })
    return { ...response, workspace_id, operation_id }
  }
  if (area === 'git' && action === 'pull') {
    const parsed = parseWords(rest, [], [], 'git pull')
    const [workspace_id, index_token] = positionals(
      parsed,
      2,
      'git pull requires WORKSPACE_ID INDEX_TOKEN --operation-id ID',
    )
    const operation_id = requiredOperationId()
    const response = await call(socketPath, 'review.pull', { workspace_id, operation_id, index_token })
    return { ...response, workspace_id, operation_id }
  }
  if (area === 'git' && action === 'push') {
    const parsed = parseWords(rest, ['--remote'], [], 'git push')
    const [workspace_id, index_token] = positionals(
      parsed,
      2,
      'git push requires WORKSPACE_ID INDEX_TOKEN --operation-id ID [--remote NAME]',
    )
    const operation_id = requiredOperationId()
    const response = await call(socketPath, 'review.push', {
      workspace_id,
      operation_id,
      index_token,
      ...(parsed.options['--remote'] === undefined ? {} : { remote: parsed.options['--remote'] }),
    })
    return { ...response, workspace_id, operation_id }
  }
  if (area === 'git' && (action === 'stage' || action === 'unstage' || action === 'commit' || action === 'discard')) {
    const { workspaceId, value, token, requestId, diffToken } = gitMutationArgs(rest, action)
    const response = await withJournals(({ git }, profileId) => {
      const owner = { profile_id: profileId, workspace_id: workspaceId, request_id: requestId }
      const intent: GitIntent =
        action === 'commit'
          ? { ...owner, op: 'review.commit', message: value, index_token: token }
          : action === 'discard'
            ? {
                ...owner,
                op: 'review.discard',
                path: value,
                revision: token,
                diff_token: required(diffToken, 'DIFF_TOKEN'),
              }
            : { ...owner, op: action === 'stage' ? 'review.stage' : 'review.unstage', path: value, revision: token }
      return gitJournalFailure(() => sendGitMutation(git, socketPath, intent, { oneAtATime: false }))
    })
    return { ...response, workspace_id: workspaceId, operation_id: requestId }
  }
  if (area === 'git' && action === 'recovery') {
    const [workspaceId] = positionals(parseWords(rest, [], [], 'git recovery'), 1, 'git recovery requires WORKSPACE_ID')
    return withJournals(async ({ git }, profileId) => ({
      type: 'git_recovery',
      ...(await readGitJournal(git, socketPath, profileId, workspaceId)),
    }))
  }
  return undefined
}
