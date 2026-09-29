import { resolve } from 'node:path'
import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, requiredOperationId, type CommandResult } from '../shared.js'

export const skillUsage = `  skill list                             List catalog skills and discovered provider skills
  skill discover [--workspace ID]       Scan provider skill paths; reads only
  skill inspect NAME [--workspace ID]   Show a skill's files, provenance and provider projection
  skill install PATH --operation-id ID [--pin HASH] [--replace HASH]
                                        Copy a local skill directory into the catalog
  skill adopt PATH HASH --operation-id ID [--workspace ID]
                                        Take ownership of a discovered provider skill
  skill remove NAME HASH --operation-id ID
                                        Remove a catalog skill; provider files stay
  skill place NAME HASH PROVIDER --operation-id ID [--workspace ID]
                                        Write a catalog skill where PROVIDER reads it; never over another owner's skill
`

function split(
  rest: string[],
  positional: number,
  allowed: readonly string[],
  command: string,
): { args: string[]; options: Record<string, string> } {
  if (rest.length < positional)
    throw new CliError('usage', `skill ${command} is missing arguments. Run ade --help for usage.`)
  return { args: rest.slice(0, positional), options: namedOptions(rest.slice(positional), allowed, `skill ${command}`) }
}

export async function runSkillCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'skill') return undefined
  if (action === 'list') {
    if (rest.length) throw new CliError('usage', 'skill list does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'skill.list' })
  }
  if (action === 'discover') {
    const { options } = split(rest, 0, ['--workspace'], 'discover')
    return dailyUseCommand(socketPath, {
      op: 'skill.discover',
      ...(options['--workspace'] ? { workspace_id: options['--workspace'] } : {}),
    })
  }
  if (action === 'inspect') {
    const { args, options } = split(rest, 1, ['--workspace'], 'inspect')
    return dailyUseCommand(socketPath, {
      op: 'skill.inspect',
      name: required(args[0], 'NAME'),
      ...(options['--workspace'] ? { workspace_id: options['--workspace'] } : {}),
    })
  }
  if (action === 'install') {
    const { args, options } = split(rest, 1, ['--pin', '--replace'], 'install')
    return dailyUseCommand(socketPath, {
      op: 'skill.install',
      operation_id: requiredOperationId(),
      source_path: resolve(required(args[0], 'PATH')),
      ...(options['--pin'] ? { expected_content_hash: options['--pin'] } : {}),
      ...(options['--replace'] ? { replace_content_hash: options['--replace'] } : {}),
    })
  }
  if (action === 'adopt') {
    const { args, options } = split(rest, 2, ['--workspace'], 'adopt')
    return dailyUseCommand(socketPath, {
      op: 'skill.adopt',
      operation_id: requiredOperationId(),
      path: resolve(required(args[0], 'PATH')),
      expected_content_hash: required(args[1], 'HASH'),
      ...(options['--workspace'] ? { workspace_id: options['--workspace'] } : {}),
    })
  }
  if (action === 'remove') {
    const { args } = split(rest, 2, [], 'remove')
    return dailyUseCommand(socketPath, {
      op: 'skill.remove',
      operation_id: requiredOperationId(),
      name: required(args[0], 'NAME'),
      expected_content_hash: required(args[1], 'HASH'),
    })
  }
  if (action === 'place') {
    const { args, options } = split(rest, 3, ['--workspace'], 'place')
    const workspace = options['--workspace']
    return dailyUseCommand(socketPath, {
      op: 'skill.place',
      operation_id: requiredOperationId(),
      name: required(args[0], 'NAME'),
      expected_content_hash: required(args[1], 'HASH'),
      provider: required(args[2], 'PROVIDER'),
      scope: workspace ? 'workspace' : 'global',
      ...(workspace ? { workspace_id: workspace } : {}),
    })
  }
  return undefined
}
