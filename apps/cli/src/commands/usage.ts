import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const usageAnalyticsUsage = `  usage summary --by conversation|workspace|provider|account|day [FILTERS] [--utc-offset MINUTES]
                                        Total the tokens and estimated cost providers reported;
                                        each figure counts the turns that did not report it.
                                        Days use this machine's current UTC offset unless given
  usage turns [FILTERS] [--limit 1..100] [--cursor CURSOR]
                                        List per-turn usage records, most recent first
  usage limits [--provider ID] [--account ID]
                                        Show the rate-limit windows providers last reported
    FILTERS: [--workspace ID] [--provider ID] [--account ID] [--conversation ID]
             [--since TIME] [--until TIME], TIME as an ISO date or epoch milliseconds
`

const FILTER_OPTIONS = ['--workspace', '--provider', '--account', '--conversation', '--since', '--until'] as const

function time(value: string, label: string): number {
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isSafeInteger(ms)) throw new CliError('usage', `${label} must be an ISO date or epoch milliseconds.`)
  return ms
}

function integer(value: string, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CliError('usage', `${label} must be an integer from ${min} to ${max}.`)
  }
  return number
}

function filters(options: Record<string, string>): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  if (options['--workspace'] !== undefined) fields.workspace_id = options['--workspace']
  if (options['--provider'] !== undefined) fields.provider = options['--provider']
  if (options['--account'] !== undefined) fields.account_id = options['--account']
  if (options['--conversation'] !== undefined) fields.conversation_id = options['--conversation']
  if (options['--since'] !== undefined) fields.since = time(options['--since'], '--since')
  if (options['--until'] !== undefined) fields.until = time(options['--until'], '--until')
  return fields
}

const GROUPS = ['conversation', 'workspace', 'provider', 'account', 'day'] as const

export async function runUsageCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'usage') return undefined
  if (action === 'summary') {
    const options = namedOptions(rest, ['--by', '--utc-offset', ...FILTER_OPTIONS], 'usage summary')
    const by = required(options['--by'], '--by')
    const group_by = GROUPS.find((group) => group === by)
    if (!group_by) throw new CliError('usage', `--by must be one of ${GROUPS.join(', ')}.`)
    const utc_offset_minutes =
      options['--utc-offset'] !== undefined
        ? integer(options['--utc-offset'], -840, 840, '--utc-offset')
        : -new Date().getTimezoneOffset()
    return dailyUseCommand(socketPath, { op: 'usage.summary', group_by, utc_offset_minutes, ...filters(options) })
  }
  if (action === 'turns') {
    const options = namedOptions(rest, ['--limit', '--cursor', ...FILTER_OPTIONS], 'usage turns')
    return dailyUseCommand(socketPath, {
      op: 'usage.turns',
      ...filters(options),
      ...(options['--cursor'] !== undefined ? { cursor: options['--cursor'] } : {}),
      ...(options['--limit'] !== undefined ? { limit: integer(options['--limit'], 1, 100, '--limit') } : {}),
    })
  }
  if (action === 'limits') {
    const options = namedOptions(rest, ['--provider', '--account'], 'usage limits')
    return dailyUseCommand(socketPath, {
      op: 'usage.limits',
      ...(options['--provider'] !== undefined ? { provider: options['--provider'] } : {}),
      ...(options['--account'] !== undefined ? { account_id: options['--account'] } : {}),
    })
  }
  return undefined
}
