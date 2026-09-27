import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const accountSwitchUsage = `  account switch preview CONVERSATION ACCOUNT
                                        Show whether and how the conversation can move to ACCOUNT
  account switch apply CONVERSATION ACCOUNT --from ACCOUNT|ambient --generation N
      --continuity native_continuation|new_native_session --request-id ID
                                        Use ACCOUNT for future turns; refused during a turn
  account switch list CONVERSATION       Show the conversation's recorded account switches
`

const continuities = ['native_continuation', 'new_native_session'] as const

function generation(value: string): number {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new CliError('usage', '--generation must be a nonnegative integer.')
  }
  return number
}

export async function runAccountSwitchCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'account' || action !== 'switch') return undefined
  const [verb, ...words] = rest
  if (verb === 'list') {
    if (words.length !== 1) throw new CliError('usage', 'account switch list requires CONVERSATION.')
    return dailyUseCommand(socketPath, {
      op: 'account.switch.list',
      conversation_id: required(words[0], 'CONVERSATION'),
    })
  }
  if (verb === 'preview') {
    if (words.length !== 2) throw new CliError('usage', 'account switch preview requires CONVERSATION ACCOUNT.')
    return dailyUseCommand(socketPath, {
      op: 'account.switch.preview',
      conversation_id: required(words[0], 'CONVERSATION'),
      account_id: required(words[1], 'ACCOUNT'),
    })
  }
  if (verb === 'apply') {
    if (words.length < 2) throw new CliError('usage', 'account switch apply requires CONVERSATION ACCOUNT.')
    const options = namedOptions(
      words.slice(2),
      ['--from', '--generation', '--continuity', '--request-id'],
      'account switch apply',
    )
    const from = required(options['--from'], '--from')
    const continuity = continuities.find((value) => value === options['--continuity'])
    if (!continuity) throw new CliError('usage', `--continuity must be ${continuities.join(' or ')}.`)
    return dailyUseCommand(socketPath, {
      op: 'account.switch',
      operation_id: required(options['--request-id'], '--request-id'),
      conversation_id: required(words[0], 'CONVERSATION'),
      account_id: required(words[1], 'ACCOUNT'),
      expected_account_id: from === 'ambient' ? null : from,
      expected_generation: generation(required(options['--generation'], '--generation')),
      continuity,
    })
  }
  throw new CliError('usage', 'account switch needs preview, apply or list. Run ade --help for usage.')
}
