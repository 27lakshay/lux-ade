import { dailyUseCommand } from '@ade/client'
import { CliError, jsonObject, effectOperationId, required, type CommandResult } from '../shared.js'

export const accountUsage = `  account list                           List profile accounts
  account create PROVIDER NAME           Register a native account home
  account inspect ID                     Check current Claude, Codex or Oh My Pi readiness
  account verify ID EXPECTED_GENERATION IDENTITY_JSON
                                        Pin only the identity returned by account inspect
  account disable ID                     Disable new ADE launches; does not log out native CLI or stop running agents
`

function generation(value: string | undefined): number {
  if (value === undefined) throw new CliError('usage', 'EXPECTED_GENERATION is required.')
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliError('usage', 'EXPECTED_GENERATION must be a nonnegative integer.')
  }
  return number
}

export async function runAccountCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area === 'account' && action === 'list') {
    if (rest.length) throw new CliError('usage', 'account list does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'account.list' })
  }
  if (area === 'account' && action === 'create') {
    if (rest.length !== 2) throw new CliError('usage', 'account create requires PROVIDER NAME.')
    return dailyUseCommand(socketPath, {
      op: 'account.create',
      operation_id: effectOperationId(),
      provider: required(rest[0], 'PROVIDER'),
      name: required(rest[1], 'NAME'),
    })
  }
  if (area === 'account' && (action === 'inspect' || action === 'verify' || action === 'disable')) {
    const count = action === 'verify' ? 3 : 1
    if (rest.length !== count)
      throw new CliError(
        'usage',
        `account ${action} requires ${action === 'verify' ? 'ID EXPECTED_GENERATION IDENTITY_JSON' : 'ID'}.`,
      )
    const account_id = required(rest[0], 'ID')
    if (action === 'verify') {
      return dailyUseCommand(socketPath, {
        op: 'account.verify',
        account_id,
        expected_generation: generation(rest[1]),
        expected_identity: jsonObject(rest[2], 'IDENTITY_JSON'),
      })
    }
    return dailyUseCommand(socketPath, { op: action === 'inspect' ? 'account.inspect' : 'account.disable', account_id })
  }
  return undefined
}
