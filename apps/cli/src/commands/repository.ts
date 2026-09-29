import {
  dailyUseCommand,
  decodeDailyUseRequest,
  decodeDailyUseResponse,
  requestDaemon,
  type DailyUseRequest,
} from '@ade/client'
import { CliError, namedOptions, required, requiredOperationId, type CommandResult } from '../shared.js'

export const repositoryUsage = `  repository coverage                   Show the Git transports clone and publish support
  repository clone URL DESTINATION --operation-id ID [--branch NAME]
                                        Clone into a new folder and register it as a project
  repository preview FOLDER URL [--remote NAME] [--initial-branch NAME] [--initial-commit]
                                        Show what publish would do, or why it refuses
  repository publish FOLDER URL --operation-id ID [--remote NAME] [--initial-branch NAME]
                     [--initial-commit] [--message TEXT]
                                        Initialise if needed, add the remote and push without force
                                        A partial result reports outcome not_pushed or
                                        cloned_not_registered with the steps that completed.
`

// Clone and push wait on the network; the daemon stops Git after 30 and 10 minutes.
const NETWORK_TIMEOUT_MS = 31 * 60_000

type RepositoryOperation = 'repository.clone' | 'repository.publish'

async function networkCommand(
  socketPath: string,
  request: DailyUseRequest<RepositoryOperation>,
): Promise<CommandResult> {
  decodeDailyUseRequest(request)
  const { op, ...fields } = request
  const response = await requestDaemon(socketPath, op, fields, { timeoutMs: NETWORK_TIMEOUT_MS })
  try {
    return decodeDailyUseResponse(op, response)
  } catch (error) {
    throw new CliError('protocol', `Daemon ${op} reply failed its contract: ${String(error)}`)
  }
}

function split(
  rest: string[],
  positional: number,
  allowed: readonly string[],
  command: string,
): { args: string[]; options: Record<string, string>; initialCommit: boolean } {
  const flags = rest.filter((word) => word === '--initial-commit').length
  if (flags > 1) throw new CliError('usage', '--initial-commit may be supplied only once.')
  const words = rest.filter((word) => word !== '--initial-commit')
  if (words.length < positional || words.slice(0, positional).some((word) => word.startsWith('--'))) {
    throw new CliError('usage', `repository ${command} is missing arguments. Run ade --help for usage.`)
  }
  return {
    args: words.slice(0, positional),
    options: namedOptions(words.slice(positional), allowed, `repository ${command}`),
    initialCommit: flags === 1,
  }
}

export async function runRepositoryCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'repository') return undefined
  if (action === 'coverage') {
    split(rest, 0, [], 'coverage')
    return dailyUseCommand(socketPath, { op: 'repository.coverage' })
  }
  if (action === 'clone') {
    const { args, options, initialCommit } = split(rest, 2, ['--branch'], 'clone')
    if (initialCommit) throw new CliError('usage', '--initial-commit applies only to publish.')
    return networkCommand(socketPath, {
      op: 'repository.clone',
      operation_id: requiredOperationId(),
      url: required(args[0], 'URL'),
      destination: required(args[1], 'DESTINATION'),
      ...(options['--branch'] ? { branch: options['--branch'] } : {}),
    })
  }
  if (action === 'preview') {
    const { args, options, initialCommit } = split(rest, 2, ['--remote', '--initial-branch'], 'preview')
    return dailyUseCommand(socketPath, {
      op: 'repository.publish.preview',
      path: required(args[0], 'FOLDER'),
      url: required(args[1], 'URL'),
      ...(options['--remote'] ? { remote: options['--remote'] } : {}),
      ...(options['--initial-branch'] ? { initial_branch: options['--initial-branch'] } : {}),
      create_initial_commit: initialCommit,
    })
  }
  if (action === 'publish') {
    const { args, options, initialCommit } = split(rest, 2, ['--remote', '--initial-branch', '--message'], 'publish')
    return networkCommand(socketPath, {
      op: 'repository.publish',
      operation_id: requiredOperationId(),
      path: required(args[0], 'FOLDER'),
      url: required(args[1], 'URL'),
      ...(options['--remote'] ? { remote: options['--remote'] } : {}),
      ...(options['--initial-branch'] ? { initial_branch: options['--initial-branch'] } : {}),
      ...(options['--message'] ? { commit_message: options['--message'] } : {}),
      create_initial_commit: initialCommit,
    })
  }
  return undefined
}
