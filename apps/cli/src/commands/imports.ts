import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const importUsage = `  import scan claude|codex [--account ID] [--workspace ID] [--limit 1..200]
                                        List native sessions in the provider's store, newest first;
                                        --workspace keeps sessions recorded inside its root
  import session claude|codex NATIVE_SESSION_ID --workspace ID [--account ID]
                                        Import a native session as a read-only conversation;
                                        repeating it adds only newly appended records
`

function provider(value: string | undefined): 'claude' | 'codex' {
  if (value === 'claude' || value === 'codex') return value
  throw new CliError('usage', 'Import provider must be claude or codex.')
}

export async function runImportCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'import') return undefined
  if (action === 'scan') {
    const options = namedOptions(rest.slice(1), ['--account', '--workspace', '--limit'], 'import scan')
    const request: {
      op: 'history.import.scan'
      provider: 'claude' | 'codex'
      account_id?: string
      workspace_id?: string
      limit?: number
    } = { op: 'history.import.scan', provider: provider(rest[0]) }
    if (options['--account'] !== undefined) request.account_id = options['--account']
    if (options['--workspace'] !== undefined) request.workspace_id = options['--workspace']
    if (options['--limit'] !== undefined) {
      const limit = Number(options['--limit'])
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new CliError('usage', '--limit must be an integer from 1 to 200.')
      }
      request.limit = limit
    }
    return dailyUseCommand(socketPath, request)
  }
  if (action === 'session') {
    const native_session_id = required(rest[1], 'NATIVE_SESSION_ID')
    const options = namedOptions(rest.slice(2), ['--account', '--workspace'], 'import session')
    const workspace_id = required(options['--workspace'], '--workspace')
    return dailyUseCommand(socketPath, {
      op: 'history.import.session',
      provider: provider(rest[0]),
      native_session_id,
      workspace_id,
      ...(options['--account'] !== undefined ? { account_id: options['--account'] } : {}),
    })
  }
  return undefined
}
