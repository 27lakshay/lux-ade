import { createHash } from 'node:crypto'
import type { DailyUseRequest } from '@ade/client'
import { CliError, effectOperationId, required, type CommandResult } from '../shared.js'
import { caller, command, newWorktree } from './orchestration.js'

export const runsUsage = `  runs start PARENT_ID TASK --run PROVIDER:inherit|ambient|ACCOUNT_ID [--run ...]
        [--workspace new-worktree|same] [--project-id ID] [--branch-prefix NAME] [--title TITLE]
        [--as-agent CONVERSATION_ID] [--operation-id ID]
                                        Start the same task as 2 to 8 sibling children in one group.
                                        Each run gets its own new worktree unless --workspace same;
                                        branches are PREFIX/N-PROVIDER in the parent's repository
  runs list PARENT_ID                   List a conversation's parallel groups and their runs' status
  runs get GROUP_ID                     Read one group and its runs' status
  runs compare GROUP_ID                 Compare each run's outcome and Git changes; merges nothing
  Retain --operation-id for runs start; a retry with the same ID and arguments resumes the same
  worktrees and returns the same group.
`

type RunSpec = DailyUseRequest<'orchestration.group.start'>['runs'][number]

const startOptions = ['--run', '--workspace', '--project-id', '--branch-prefix', '--title', '--as-agent']

/** Reads `runs start` flags; only --run may repeat. */
function startFlags(words: string[]): { runs: string[]; options: Record<string, string> } {
  const runs: string[] = []
  const options: Record<string, string> = {}
  for (let index = 0; index < words.length; index += 2) {
    const key = words[index]
    const value = words[index + 1]
    if (
      !startOptions.includes(key) ||
      !value ||
      value.startsWith('--') ||
      (key !== '--run' && options[key] !== undefined)
    ) {
      throw new CliError('usage', 'Invalid runs start option. Run ade --help for usage.')
    }
    if (key === '--run') runs.push(value)
    else options[key] = value
  }
  if (runs.length < 2 || runs.length > 8) throw new CliError('usage', 'runs start needs 2 to 8 --run options.')
  return { runs, options }
}

/** `PROVIDER:inherit`, `PROVIDER:ambient` or `PROVIDER:ACCOUNT_ID`; the account is never implied. */
function account(run: string): { provider: string; account: RunSpec['account'] } {
  const split = run.indexOf(':')
  const provider = run.slice(0, split)
  const choice = run.slice(split + 1)
  if (split < 1 || !choice) {
    throw new CliError('usage', `--run ${run} must be PROVIDER:inherit, PROVIDER:ambient or PROVIDER:ACCOUNT_ID.`)
  }
  return {
    provider,
    account: choice === 'inherit' || choice === 'ambient' ? { mode: choice } : { mode: 'managed', account_id: choice },
  }
}

/**
 * The worktree lifecycle repository of the parent Conversation's workspace:
 * its repository project, registered with the lifecycle (or found) by the
 * workspace root.
 */
async function parentRepository(socketPath: string, parent: string): Promise<string> {
  const { catalog } = await command(socketPath, 'catalog.get', {})
  const conversation = catalog.conversations.find((item) => item.id === parent)
  if (!conversation) throw new CliError('usage', `Unknown conversation ${parent}.`)
  const workspace = catalog.workspaces.find((item) => item.id === conversation.workspace_id)
  const project = catalog.projects.find((item) => item.id === workspace?.project_id)
  if (!workspace || project?.kind !== 'repository') {
    throw new CliError(
      'usage',
      'The parent workspace is not in a known repository. Pass --project-id, ' +
        'or --workspace same to share the parent workspace.',
    )
  }
  return (await command(socketPath, 'worktree.repository', { path: workspace.root })).repository.id
}

async function start(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [parentArgument, taskArgument, ...flags] = rest
  const parent = required(parentArgument, 'PARENT_ID')
  const task = required(taskArgument, 'TASK')
  const { runs: runWords, options } = startFlags(flags)
  const id = effectOperationId()
  const mode = options['--workspace'] ?? 'new-worktree'
  const choices = runWords.map(account)
  let runs: RunSpec[]
  if (mode === 'same') {
    if (options['--project-id'] || options['--branch-prefix']) {
      throw new CliError('usage', '--project-id and --branch-prefix apply only to --workspace new-worktree.')
    }
    runs = choices.map((choice) => ({ ...choice, workspace: { mode: 'same' } }))
  } else if (mode === 'new-worktree') {
    const repository = options['--project-id'] ?? (await parentRepository(socketPath, parent))
    // Branches and worktree operation IDs derive from the group's operation ID,
    // so a retry resumes the same worktrees instead of making new ones.
    const prefix =
      options['--branch-prefix'] ?? `ade/runs/${createHash('sha256').update(id).digest('hex').slice(0, 10)}`
    runs = []
    for (const [index, choice] of choices.entries()) {
      const branch = `${prefix}/${index + 1}-${choice.provider.replace(/[^A-Za-z0-9._-]/g, '-')}`
      runs.push({
        ...choice,
        workspace: {
          mode: 'new_worktree',
          ...(await newWorktree(socketPath, repository, branch, `${id}:worktree:${index}`)),
        },
      })
    }
  } else {
    throw new CliError('usage', '--workspace must be new-worktree or same.')
  }
  return command(socketPath, 'orchestration.group.start', {
    operation_id: id,
    parent_conversation_id: parent,
    caller: caller(options['--as-agent']),
    task,
    runs,
    ...(options['--title'] ? { title: options['--title'] } : {}),
  })
}

export async function runRunsCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'runs') return undefined
  if (action === 'start') return start(socketPath, rest)
  if (action === 'list' && rest.length === 1) {
    return command(socketPath, 'orchestration.groups', { parent_conversation_id: required(rest[0], 'PARENT_ID') })
  }
  if (action === 'get' && rest.length === 1) {
    return command(socketPath, 'orchestration.group.get', { group_id: required(rest[0], 'GROUP_ID') })
  }
  if (action === 'compare' && rest.length === 1) {
    return command(socketPath, 'orchestration.group.compare', { group_id: required(rest[0], 'GROUP_ID') })
  }
  return undefined
}
