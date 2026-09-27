import { dailyUseCommand } from '@ade/client'
import { CliError, jsonObject, namedOptions, required, type CommandResult } from '../shared.js'

export const worktreeLifecycleUsage = `  worktree new REPOSITORY_ID [--name NAME | --branch BRANCH] [--base BASE] [--path PATH] --request-id ID
                                        Create a named tree from repository defaults and run setup hooks
  worktree setup REPOSITORY_ID PATH --request-id ID
                                        Run setup hooks again in a tree whose setup failed
  worktree cleanup-plan REPOSITORY_ID   Classify linked trees for cleanup; changes nothing
  worktree cleanup REPOSITORY_ID PATH... [--delete-merged] --request-id ID
                                        Tear down, remove and archive eligible trees
  worktree archived REPOSITORY_ID       List archive records of removed trees
  worktree configure REPOSITORY_ID CONFIG_JSON
                                        Replace naming defaults, hooks and timeouts
`

/** Splits a trailing `--request-id ID` from the other words. */
function requestId(words: string[], command: string): { rest: string[]; id: string } {
  const at = words.length - 2
  const id = words[at + 1]
  if (at < 0 || words[at] !== '--request-id' || !id || id.startsWith('--') || id.length > 256) {
    throw new CliError('usage', `worktree ${command} requires --request-id ID last.`)
  }
  return { rest: words.slice(0, at), id }
}

export async function runWorktreeLifecycleCommand(socketPath: string, area: string | undefined,
  action: string | undefined, rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'worktree') return undefined
  if (action === 'new') {
    const { rest: words, id } = requestId(rest, 'new')
    const [repositoryId, ...optionWords] = words
    const options = namedOptions(optionWords, ['--name', '--branch', '--base', '--path'], 'worktree new')
    if (options['--name'] && options['--branch']) {
      throw new CliError('usage', 'worktree new takes --name or --branch, not both.')
    }
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.create', repository_id: required(repositoryId, 'REPOSITORY_ID'), operation_id: id,
      ...(options['--name'] ? { name: options['--name'] } : {}),
      ...(options['--branch'] ? { branch: options['--branch'] } : {}),
      ...(options['--base'] ? { base: options['--base'] } : {}),
      ...(options['--path'] ? { path: options['--path'] } : {}),
    })
    return { ...response, request_id: id }
  }
  if (action === 'setup') {
    const { rest: words, id } = requestId(rest, 'setup')
    if (words.length !== 2) throw new CliError('usage', 'worktree setup requires REPOSITORY_ID PATH --request-id ID.')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.setup', repository_id: words[0], path: words[1], operation_id: id,
    })
    return { ...response, request_id: id }
  }
  if (action === 'cleanup-plan') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree cleanup-plan requires REPOSITORY_ID.')
    return dailyUseCommand(socketPath, { op: 'worktree.cleanup.plan', repository_id: rest[0] })
  }
  if (action === 'cleanup') {
    const { rest: words, id } = requestId(rest, 'cleanup')
    const merged = words.at(-1) === '--delete-merged'
    const [repositoryId, ...paths] = merged ? words.slice(0, -1) : words
    if (!repositoryId || paths.length === 0 || paths.some((path) => path.startsWith('--'))) {
      throw new CliError('usage', 'worktree cleanup requires REPOSITORY_ID PATH... [--delete-merged] --request-id ID.')
    }
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.cleanup', repository_id: repositoryId, paths, operation_id: id,
      delete_branch: merged ? 'merged' : 'keep',
    })
    return { ...response, request_id: id }
  }
  if (action === 'archived') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree archived requires REPOSITORY_ID.')
    return dailyUseCommand(socketPath, { op: 'worktree.archived', repository_id: rest[0] })
  }
  if (action === 'configure') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree configure requires REPOSITORY_ID CONFIG_JSON.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.configure', repository_id: rest[0], config: jsonObject(rest[1], 'CONFIG_JSON'),
    })
  }
  return undefined
}
