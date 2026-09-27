import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const historyUsage = `  history search QUERY [--workspace ID] [--provider ID] [--conversation ID] [--limit 1..50] [--cursor CURSOR]
                                        Search indexed messages and review feedback across providers;
                                        the reply's index field shows how far the index lags
  history list [--workspace ID] [--provider ID] [--limit 1..100] [--cursor CURSOR]
                                        List conversations across providers, most recently updated first
  history index status                  Inspect search index lag and rebuild progress
  history index rebuild EXPECTED_EPOCH  Rebuild the search index from durable history
`

function count(value: string, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CliError('usage', `${label} must be an integer from ${min} to ${max}.`)
  }
  return number
}

function filters(options: Record<string, string>, max: number): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  if (options['--workspace'] !== undefined) fields.workspace_id = options['--workspace']
  if (options['--provider'] !== undefined) fields.provider = options['--provider']
  if (options['--conversation'] !== undefined) fields.conversation_id = options['--conversation']
  if (options['--cursor'] !== undefined) fields.cursor = options['--cursor']
  if (options['--limit'] !== undefined) {
    fields.limit = count(options['--limit'], 1, max, '--limit')
  }
  return fields
}

export async function runHistoryCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'history') return undefined
  if (action === 'search') {
    const query = required(rest[0], 'QUERY')
    const options = namedOptions(
      rest.slice(1),
      ['--workspace', '--provider', '--conversation', '--limit', '--cursor'],
      'history search',
    )
    return dailyUseCommand(socketPath, { op: 'history.search', query, ...filters(options, 50) })
  }
  if (action === 'list') {
    const options = namedOptions(rest, ['--workspace', '--provider', '--limit', '--cursor'], 'history list')
    return dailyUseCommand(socketPath, { op: 'history.list', ...filters(options, 100) })
  }
  if (action === 'index' && rest[0] === 'status' && rest.length === 1) {
    return dailyUseCommand(socketPath, { op: 'history.index.status' })
  }
  if (action === 'index' && rest[0] === 'rebuild' && rest.length === 2) {
    const expected_epoch = count(required(rest[1], 'EXPECTED_EPOCH'), 0, Number.MAX_SAFE_INTEGER, 'EXPECTED_EPOCH')
    return dailyUseCommand(socketPath, { op: 'history.index.rebuild', expected_epoch })
  }
  return undefined
}
