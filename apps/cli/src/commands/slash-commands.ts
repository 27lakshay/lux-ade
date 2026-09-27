import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const slashCommandUsage = `  command list ID                        List a conversation's slash commands and skills, with provenance
  command invoke ID command|skill NAME --request-id ID [--arguments TEXT]
                                        Queue a listed command or skill in the provider's native form
`

export async function runSlashCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'command') return undefined
  if (action === 'list') {
    if (rest.length !== 1) throw new CliError('usage', 'command list takes one conversation ID.')
    return dailyUseCommand(socketPath, { op: 'command.list', conversation_id: required(rest[0], 'ID') })
  }
  if (action === 'invoke') {
    if (rest.length < 3 || rest.slice(0, 3).some((word) => word.startsWith('--'))) {
      throw new CliError('usage', 'command invoke is missing arguments. Run ade --help for usage.')
    }
    const [conversation, kind, name] = rest
    if (kind !== 'command' && kind !== 'skill') throw new CliError('usage', 'Kind must be command or skill.')
    const options = namedOptions(rest.slice(3), ['--request-id', '--arguments'], 'command invoke')
    const reply = await dailyUseCommand<'command.invoke'>(socketPath, { op: 'command.invoke',
      operation_id: required(options['--request-id'], '--request-id'), conversation_id: conversation,
      kind, name, ...(options['--arguments'] ? { arguments: options['--arguments'] } : {}) })
    const reason = typeof reply.reason === 'string' ? reply.reason : 'No reason was given.'
    if (reply.outcome === 'unavailable') throw new CliError('unavailable', reason)
    if (reply.outcome === 'unknown') throw new CliError('outcome_unknown', reason)
    return reply
  }
  return undefined
}
