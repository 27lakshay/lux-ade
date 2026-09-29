import { dailyUseCommand } from '@ade/client'
import { CliError, jsonObject, namedOptions, required, requiredOperationId, type CommandResult } from '../shared.js'

export const worktreeLifecycleUsage = `  worktree new PROJECT_ID [--name NAME | --branch BRANCH] [--base BASE] [--path PATH] --operation-id ID
                                        Create a named tree from repository defaults and run setup hooks
  worktree new PROJECT_ID ... [--pr NUMBER | --fetch-ref REF] [--fetch-remote REMOTE] --operation-id ID
                                        Start the tree from a ref fetched from a configured remote
                                        (--pr N fetches refs/pull/N/head from origin)
  worktree carry-preview PROJECT_ID SOURCE [PATH...]
                                        List uncommitted changes a carry would move; changes nothing
  worktree carry PROJECT_ID SOURCE TARGET [PATH...] [--expect-head COMMIT] [--clean-source] --operation-id ID
                                        Save, apply and verify changes in a clean ADE-owned tree;
                                        --clean-source then removes them from SOURCE
  worktree resources PROJECT_ID PATH --operation-id ID
                                        Apply the ignored-resource rules to an ADE-owned tree
  worktree setup PROJECT_ID PATH --operation-id ID
                                        Run setup hooks again in a tree whose setup failed
  worktree cleanup-plan PROJECT_ID      Classify linked trees for cleanup; changes nothing
  worktree cleanup PROJECT_ID PATH... [--delete-merged] --operation-id ID
                                        Tear down, remove and archive eligible trees
  worktree archived PROJECT_ID          List archive records of removed trees
  worktree configure PROJECT_ID CONFIG_JSON
                                        Replace naming defaults, hooks and timeouts
`

/** The command's words, and the operation ID its caller chose with `--operation-id`. */
function requestId(words: string[]): { rest: string[]; id: string } {
  return { rest: words, id: requiredOperationId() }
}

/** The fetched creation source `worktree new` options name, if any. */
function fetchSource(options: Record<string, string>): { remote: string; ref: string } | undefined {
  const pr = options['--pr']
  const ref = options['--fetch-ref']
  if (pr && ref) throw new CliError('usage', 'worktree new takes --pr or --fetch-ref, not both.')
  if (options['--fetch-remote'] && !pr && !ref) {
    throw new CliError('usage', 'worktree new --fetch-remote needs --pr or --fetch-ref.')
  }
  if (!pr && !ref) return undefined
  if (options['--base']) throw new CliError('usage', 'worktree new takes --base or a fetched source, not both.')
  if (pr && !/^[1-9][0-9]{0,9}$/.test(pr)) throw new CliError('usage', '--pr takes a positive number.')
  return { remote: options['--fetch-remote'] ?? 'origin', ref: pr ? `refs/pull/${pr}/head` : ref }
}

/** Parses `PROJECT_ID SOURCE TARGET [PATH...] [--expect-head COMMIT] [--clean-source]`. */
function carryWords(words: string[]): {
  project_id: string
  source: string
  target: string
  paths?: string[]
  expect_head?: string
  clean_source?: boolean
} {
  const positional: string[] = []
  let expectHead: string | undefined
  let clean = false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === '--clean-source' && !clean) {
      clean = true
    } else if (word === '--expect-head' && expectHead === undefined) {
      expectHead = words[index + 1]
      if (!expectHead || expectHead.startsWith('--')) throw new CliError('usage', '--expect-head takes a commit ID.')
      index += 1
    } else if (word.startsWith('--')) {
      throw new CliError('usage', `Unknown worktree carry option ${word}.`)
    } else {
      positional.push(word)
    }
  }
  const [projectId, source, target, ...paths] = positional
  if (!projectId || !source || !target) {
    throw new CliError('usage', 'worktree carry requires PROJECT_ID SOURCE TARGET [PATH...] --operation-id ID.')
  }
  return {
    project_id: projectId,
    source,
    target,
    ...(paths.length > 0 ? { paths } : {}),
    ...(expectHead ? { expect_head: expectHead } : {}),
    ...(clean ? { clean_source: true } : {}),
  }
}

export async function runWorktreeLifecycleCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'worktree') return undefined
  if (action === 'new') {
    const { rest: words, id } = requestId(rest)
    const [projectId, ...optionWords] = words
    const options = namedOptions(
      optionWords,
      ['--name', '--branch', '--base', '--path', '--pr', '--fetch-ref', '--fetch-remote'],
      'worktree new',
    )
    if (options['--name'] && options['--branch']) {
      throw new CliError('usage', 'worktree new takes --name or --branch, not both.')
    }
    const fetch = fetchSource(options)
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.create',
      project_id: required(projectId, 'PROJECT_ID'),
      operation_id: id,
      ...(options['--name'] ? { name: options['--name'] } : {}),
      ...(options['--branch'] ? { branch: options['--branch'] } : {}),
      ...(options['--base'] ? { base: options['--base'] } : {}),
      ...(options['--path'] ? { path: options['--path'] } : {}),
      ...(fetch ? { fetch } : {}),
    })
    return { ...response, operation_id: id }
  }
  if (action === 'carry-preview') {
    const [projectId, source, ...paths] = rest
    if (!projectId || !source || paths.some((path) => path.startsWith('--'))) {
      throw new CliError('usage', 'worktree carry-preview requires PROJECT_ID SOURCE [PATH...].')
    }
    return dailyUseCommand(socketPath, {
      op: 'worktree.carry.preview',
      project_id: projectId,
      source,
      ...(paths.length > 0 ? { paths } : {}),
    })
  }
  if (action === 'carry') {
    const { rest: words, id } = requestId(rest)
    const carry = carryWords(words)
    const response = await dailyUseCommand(socketPath, { op: 'worktree.carry', operation_id: id, ...carry })
    return { ...response, operation_id: id }
  }
  if (action === 'resources') {
    const { rest: words, id } = requestId(rest)
    if (words.length !== 2)
      throw new CliError('usage', 'worktree resources requires PROJECT_ID PATH --operation-id ID.')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.resources.apply',
      project_id: words[0],
      path: words[1],
      operation_id: id,
    })
    return { ...response, operation_id: id }
  }
  if (action === 'setup') {
    const { rest: words, id } = requestId(rest)
    if (words.length !== 2) throw new CliError('usage', 'worktree setup requires PROJECT_ID PATH --operation-id ID.')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.setup',
      project_id: words[0],
      path: words[1],
      operation_id: id,
    })
    return { ...response, operation_id: id }
  }
  if (action === 'cleanup-plan') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree cleanup-plan requires PROJECT_ID.')
    return dailyUseCommand(socketPath, { op: 'worktree.cleanup.plan', project_id: rest[0] })
  }
  if (action === 'cleanup') {
    const { rest: words, id } = requestId(rest)
    const merged = words.at(-1) === '--delete-merged'
    const [projectId, ...paths] = merged ? words.slice(0, -1) : words
    if (!projectId || paths.length === 0 || paths.some((path) => path.startsWith('--'))) {
      throw new CliError('usage', 'worktree cleanup requires PROJECT_ID PATH... [--delete-merged] --operation-id ID.')
    }
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.cleanup',
      project_id: projectId,
      paths,
      operation_id: id,
      delete_branch: merged ? 'merged' : 'keep',
    })
    return { ...response, operation_id: id }
  }
  if (action === 'archived') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree archived requires PROJECT_ID.')
    return dailyUseCommand(socketPath, { op: 'worktree.archived', project_id: rest[0] })
  }
  if (action === 'configure') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree configure requires PROJECT_ID CONFIG_JSON.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.configure',
      project_id: rest[0],
      config: jsonObject(rest[1], 'CONFIG_JSON'),
    })
  }
  return undefined
}
