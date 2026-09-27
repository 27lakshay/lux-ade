import { dailyUseCommand, requestDaemon } from '@ade/client'
import { catalog, CliError, required, type CommandResult } from '../shared.js'

export const workspaceUsage = `  workspace list                        List registered workspaces
  workspace open PATH                   Register a repository or folder
  workspace rebind WORKSPACE_ID PATH    Bind a restored workspace to a verified directory
  repository rebind REPOSITORY_ID PATH  Bind a restored Git repository before its workspaces
  worktree register PATH                Register a Git repository lifecycle
  worktree list REPOSITORY_ID           Inspect linked trees and removal authority
  worktree create REPOSITORY_ID BRANCH BASE [PATH] --request-id ID
                                        Create a branch and linked tree
  worktree adopt REPOSITORY_ID PATH CONFIRM_PATH
                                        Explicitly take ADE removal authority
  worktree remove REPOSITORY_ID PATH [--delete-merged] --request-id ID
                                        Remove a clean ADE-authorized tree
  worktree operation REPOSITORY_ID REQUEST_ID
                                        Inspect a lifecycle operation receipt
  worktree rebind-list                  List restored lifecycle repositories requiring a path
  worktree rebind REPOSITORY_ID PATH    Bind restored Git lifecycle history first
`

function worktreeMutationArgs(rest: string[], action: 'create' | 'remove'): {
  positionals: string[]; requestId: string
} {
  const flag = rest.length - 2
  const positionals = rest.slice(0, flag)
  const valid = action === 'create'
    ? positionals.length === 3 || positionals.length === 4
    : positionals.length === 2 || (positionals.length === 3 && positionals[2] === '--delete-merged')
  if (!valid || rest[flag] !== '--request-id' || !rest[flag + 1] ||
    rest[flag + 1].startsWith('--') || rest[flag + 1].length > 256) {
    throw new CliError('usage', `worktree ${action} requires ${action === 'create'
      ? 'REPOSITORY_ID BRANCH BASE [PATH]' : 'REPOSITORY_ID PATH [--delete-merged]'} --request-id ID.`)
  }
  return { positionals, requestId: rest[flag + 1] }
}

export async function runWorkspaceCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'workspace' && action === 'list') return { type: 'workspaces', workspaces: (await catalog(socketPath)).workspaces }
  if (area === 'workspace' && action === 'open') return dailyUseCommand(socketPath, { op: 'workspace.open', path: required(rest[0], 'PATH') })
  if (area === 'workspace' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'workspace rebind requires WORKSPACE_ID PATH.')
    return dailyUseCommand(socketPath, {
      op: 'workspace.rebind', workspace_id: required(rest[0], 'WORKSPACE_ID'), path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'repository' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'repository rebind requires REPOSITORY_ID PATH.')
    return dailyUseCommand(socketPath, {
      op: 'repository.rebind', repository_id: required(rest[0], 'REPOSITORY_ID'), path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'worktree' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree rebind requires REPOSITORY_ID PATH.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.rebind', repository_id: required(rest[0], 'REPOSITORY_ID'), path: required(rest[1], 'PATH'),
    })
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
    if (rest.length !== 1) throw new CliError('usage', 'worktree list requires REPOSITORY_ID.')
    return dailyUseCommand(socketPath, { op: 'worktree.get', repository_id: rest[0] })
  }
  if (area === 'worktree' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree operation requires REPOSITORY_ID REQUEST_ID.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.operation', repository_id: required(rest[0], 'REPOSITORY_ID'),
      operation_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'worktree' && action === 'create') {
    const { positionals, requestId } = worktreeMutationArgs(rest, 'create')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.switch', repository_id: positionals[0], target: positionals[1], base: positionals[2],
      ...(positionals[3] ? { path: positionals[3] } : {}), create: true, operation_id: requestId,
    })
    return { ...response, request_id: requestId }
  }
  if (area === 'worktree' && action === 'adopt') {
    if (rest.length !== 3) throw new CliError('usage', 'worktree adopt requires REPOSITORY_ID PATH CONFIRM_PATH.')
    return dailyUseCommand(socketPath, {
      op: 'worktree.adopt', repository_id: rest[0], path: rest[1], confirm_path: rest[2],
    })
  }
  if (area === 'worktree' && action === 'remove') {
    const { positionals, requestId } = worktreeMutationArgs(rest, 'remove')
    const response = await dailyUseCommand(socketPath, {
      op: 'worktree.remove', repository_id: positionals[0], path: positionals[1],
      delete_branch: positionals[2] ? 'merged' : 'keep', operation_id: requestId,
    })
    return { ...response, request_id: requestId }
  }
  return undefined
}
