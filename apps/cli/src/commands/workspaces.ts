import { setTimeout as delay } from 'node:timers/promises'
import { dailyUseCommand, type DailyUseResponse } from '@ade/client'
import {
  catalog,
  CliError,
  effectOperationId,
  parseWords,
  positionals,
  required,
  requiredOperationId,
  type CommandResult,
} from '../shared.js'

export const workspaceUsage = `  workspace list                        List registered workspaces
  workspace open PATH                   Register a repository or folder, or restore a removed one
  workspace rename WORKSPACE_ID NAME    Change the name ADE shows; the folder and branch stay
  workspace remove WORKSPACE_ID         Remove from ADE: stop its terminals, keep its files
  workspace create-worktree PROJECT_ID NAME [--base REF] [--wait]
                                        Create a worktree of a repository project and open it
                                        as a workspace named NAME; --wait until it is ready
  workspace delete-worktree WORKSPACE_ID [--delete-merged] [--wait]
                                        Remove a linked worktree's workspace, then its tree;
                                        --wait until the tree is gone
  workspace rebind-list                 List restored workspaces requiring a directory
  workspace rebind WORKSPACE_ID PATH    Bind a restored workspace to a verified directory
  repository rebind-list                List restored Git repositories requiring a path
  repository rebind REPOSITORY_ID PATH  Bind a restored Git repository before its workspaces
  worktree register PATH                Register a Git repository lifecycle
  worktree list PROJECT_ID              Inspect linked trees and removal authority
  worktree refresh PROJECT_ID --operation-id ID
                                        Re-read the Git worktree listing under the repository lock
  worktree create PROJECT_ID BRANCH BASE [PATH] --operation-id ID
                                        Create a branch and linked tree
  worktree adopt PROJECT_ID PATH CONFIRM_PATH
                                        Explicitly take ADE removal authority
  worktree remove PROJECT_ID PATH [--delete-merged] --operation-id ID
                                        Remove a clean ADE-authorized tree
  worktree operation PROJECT_ID OPERATION_ID
                                        Inspect a lifecycle operation receipt
  worktree rebind-list                  List restored lifecycle repositories requiring a path
  worktree rebind PROJECT_ID PATH       Bind restored Git lifecycle history first
`

function worktreeMutationArgs(
  rest: string[],
  action: 'create' | 'remove',
): {
  positionals: string[]
  requestId: string
} {
  const positionals = rest
  const valid =
    action === 'create'
      ? positionals.length === 3 || positionals.length === 4
      : positionals.length === 2 || (positionals.length === 3 && positionals[2] === '--delete-merged')
  if (!valid) {
    throw new CliError(
      'usage',
      `worktree ${action} requires ${
        action === 'create' ? 'PROJECT_ID BRANCH BASE [PATH]' : 'PROJECT_ID PATH [--delete-merged]'
      } --operation-id ID.`,
    )
  }
  return { positionals, requestId: requiredOperationId() }
}

/** How long `--wait` follows a worktree operation, setup hooks included. */
const WAIT_MS = 15 * 60_000

type WorktreeOperation = DailyUseResponse<'workspace.create_worktree'>

/**
 * Sends a workspace worktree operation and, with `--wait`, sends it again
 * under the same operation ID until it leaves `running`: a retry of the same
 * request returns its current state and never runs it twice.
 */
async function worktreeOperation(send: () => Promise<WorktreeOperation>, wait: boolean): Promise<WorktreeOperation> {
  const deadline = Date.now() + WAIT_MS
  let state = await send()
  while (wait && state.status === 'running') {
    if (Date.now() > deadline) throw new CliError('timeout', 'The worktree operation is still running; retry it later.')
    await delay(250)
    state = await send()
  }
  if (state.status === 'failed') process.exitCode = 16
  return state
}

export async function runWorkspaceCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area === 'workspace' && action === 'create-worktree') {
    const parsed = parseWords(rest, ['--base'], ['--wait'], 'workspace create-worktree')
    const [projectId, name] = positionals(parsed, 2, 'workspace create-worktree requires PROJECT_ID NAME')
    const base = parsed.options['--base']
    const operationId = effectOperationId()
    return worktreeOperation(
      () =>
        dailyUseCommand(socketPath, {
          op: 'workspace.create_worktree',
          operation_id: operationId,
          project_id: projectId!,
          name: name!,
          ...(base ? { base } : {}),
        }),
      parsed.flags.has('--wait'),
    )
  }
  if (area === 'workspace' && action === 'delete-worktree') {
    const parsed = parseWords(rest, [], ['--delete-merged', '--wait'], 'workspace delete-worktree')
    const [workspaceId] = positionals(parsed, 1, 'workspace delete-worktree requires WORKSPACE_ID')
    const operationId = effectOperationId()
    return worktreeOperation(
      () =>
        dailyUseCommand(socketPath, {
          op: 'workspace.delete_worktree',
          operation_id: operationId,
          workspace_id: workspaceId!,
          ...(parsed.flags.has('--delete-merged') ? { delete_branch: 'merged' as const } : {}),
        }),
      parsed.flags.has('--wait'),
    )
  }
  if (area === 'workspace' && action === 'list')
    return { type: 'workspaces', workspaces: (await catalog(socketPath)).workspaces }
  if (area === 'workspace' && action === 'open')
    return dailyUseCommand(socketPath, { op: 'workspace.open', path: required(rest[0], 'PATH') })
  if (area === 'workspace' && action === 'rename') {
    if (rest.length !== 2) throw new CliError('usage', 'workspace rename requires WORKSPACE_ID NAME.')
    return dailyUseCommand(socketPath, {
      op: 'workspace.rename',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      name: rest[1],
    })
  }
  if (area === 'workspace' && action === 'remove') {
    if (rest.length !== 1) throw new CliError('usage', 'workspace remove requires WORKSPACE_ID.')
    return dailyUseCommand(socketPath, {
      op: 'workspace.remove',
      operation_id: effectOperationId(),
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
    })
  }
  if (area === 'workspace' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'workspace rebind requires WORKSPACE_ID PATH.')
    return dailyUseCommand(socketPath, {
      op: 'workspace.rebind',
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'repository' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'repository rebind requires REPOSITORY_ID PATH.')
    return dailyUseCommand(socketPath, {
      op: 'repository.rebind',
      repository_id: required(rest[0], 'REPOSITORY_ID'),
      path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'worktree' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree rebind requires PROJECT_ID PATH.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.rebind',
      project_id: required(rest[0], 'PROJECT_ID'),
      path: required(rest[1], 'PATH'),
    })
  }
  if ((area === 'workspace' || area === 'repository') && action === 'rebind-list') {
    if (rest.length) throw new CliError('usage', `${area} rebind-list does not accept arguments.`)
    return area === 'workspace'
      ? dailyUseCommand(socketPath, { op: 'workspace.rebind.list' })
      : dailyUseCommand(socketPath, { op: 'repository.rebind.list' })
  }
  if (area === 'worktree' && action === 'refresh') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree refresh requires PROJECT_ID --operation-id ID.')
    const operationId = requiredOperationId()
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.refresh',
      project_id: required(rest[0], 'PROJECT_ID'),
      operation_id: operationId,
    })
    return { ...response, operation_id: operationId }
  }
  if (area === 'worktree' && action === 'rebind-list') {
    if (rest.length) throw new CliError('usage', 'worktree rebind-list does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'worktree.rebind.list' })
  }
  if (area === 'worktree' && action === 'register') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree register requires PATH.')
    return dailyUseCommand(socketPath, { op: 'worktree.repository', path: rest[0] })
  }
  if (area === 'worktree' && action === 'list') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree list requires PROJECT_ID.')
    return dailyUseCommand(socketPath, { op: 'worktree.get', project_id: rest[0] })
  }
  if (area === 'worktree' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree operation requires PROJECT_ID OPERATION_ID.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.operation',
      project_id: required(rest[0], 'PROJECT_ID'),
      operation_id: required(rest[1], 'OPERATION_ID'),
    })
  }
  if (area === 'worktree' && action === 'create') {
    const { positionals, requestId } = worktreeMutationArgs(rest, 'create')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.switch',
      project_id: positionals[0],
      target: positionals[1],
      base: positionals[2],
      ...(positionals[3] ? { path: positionals[3] } : {}),
      create: true,
      operation_id: requestId,
    })
    return { ...response, operation_id: requestId }
  }
  if (area === 'worktree' && action === 'adopt') {
    if (rest.length !== 3) throw new CliError('usage', 'worktree adopt requires PROJECT_ID PATH CONFIRM_PATH.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.adopt',
      operation_id: effectOperationId(),
      project_id: rest[0],
      path: rest[1],
      confirm_path: rest[2],
    })
  }
  if (area === 'worktree' && action === 'remove') {
    const { positionals, requestId } = worktreeMutationArgs(rest, 'remove')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.remove',
      project_id: positionals[0],
      path: positionals[1],
      delete_branch: positionals[2] ? 'merged' : 'keep',
      operation_id: requestId,
    })
    return { ...response, operation_id: requestId }
  }
  return undefined
}
