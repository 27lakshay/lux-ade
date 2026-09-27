import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const checkpointUsage = `  checkpoint list WORKSPACE             List a workspace's checkpoints, newest first
  checkpoint create WORKSPACE --request-id ID [--label TEXT]
                                        Record the working tree and index under a private Git ref
  checkpoint preview WORKSPACE CHECKPOINT
                                        Show what a restore would change and its state token
  checkpoint restore WORKSPACE CHECKPOINT STATE_TOKEN --request-id ID [--confirm-overwrite]
                                        Restore a checkpoint; saves a safety checkpoint first
  checkpoint delete WORKSPACE CHECKPOINT COMMIT --request-id ID
                                        Remove a checkpoint's ref
`

function split(rest: string[], positional: number, allowed: readonly string[], command: string):
  { args: string[]; options: Record<string, string> } {
  if (rest.length < positional || rest.slice(0, positional).some((word) => word.startsWith('--'))) {
    throw new CliError('usage', `checkpoint ${command} is missing arguments. Run ade --help for usage.`)
  }
  return { args: rest.slice(0, positional), options: namedOptions(rest.slice(positional), allowed, `checkpoint ${command}`) }
}

export async function runCheckpointCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'checkpoint') return undefined
  if (action === 'list') {
    const { args } = split(rest, 1, [], 'list')
    return dailyUseCommand(socketPath, { op: 'checkpoint.list', workspace_id: required(args[0], 'WORKSPACE') })
  }
  if (action === 'create') {
    const { args, options } = split(rest, 1, ['--request-id', '--label'], 'create')
    return dailyUseCommand(socketPath, { op: 'checkpoint.create',
      operation_id: required(options['--request-id'], '--request-id'),
      workspace_id: required(args[0], 'WORKSPACE'),
      ...(options['--label'] ? { label: options['--label'] } : {}) })
  }
  if (action === 'preview') {
    const { args } = split(rest, 2, [], 'preview')
    return dailyUseCommand(socketPath, { op: 'checkpoint.restore.preview',
      workspace_id: required(args[0], 'WORKSPACE'), checkpoint_id: required(args[1], 'CHECKPOINT') })
  }
  if (action === 'restore') {
    const confirm = rest.includes('--confirm-overwrite')
    const { args, options } = split(rest.filter((word) => word !== '--confirm-overwrite'), 3, ['--request-id'],
      'restore')
    if (rest.filter((word) => word === '--confirm-overwrite').length > 1) {
      throw new CliError('usage', '--confirm-overwrite may be supplied only once.')
    }
    return dailyUseCommand(socketPath, { op: 'checkpoint.restore',
      operation_id: required(options['--request-id'], '--request-id'),
      workspace_id: required(args[0], 'WORKSPACE'), checkpoint_id: required(args[1], 'CHECKPOINT'),
      expected_state: required(args[2], 'STATE_TOKEN'), confirm_overwrite: confirm })
  }
  if (action === 'delete') {
    const { args, options } = split(rest, 3, ['--request-id'], 'delete')
    return dailyUseCommand(socketPath, { op: 'checkpoint.delete',
      operation_id: required(options['--request-id'], '--request-id'),
      workspace_id: required(args[0], 'WORKSPACE'), checkpoint_id: required(args[1], 'CHECKPOINT'),
      expected_commit: required(args[2], 'COMMIT') })
  }
  return undefined
}
