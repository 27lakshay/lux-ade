import { dailyUseCommand } from '@ade/client'
import { CliError, required, type CommandResult } from '../shared.js'

export const recoveryUsage = `  recovery list [--open]                Show runtime restart reconciliation reports; --open keeps unresolved ones
  recovery release REPORT_ID ATTEMPT_KEY
                                        Accept an unknown attempt as stopped without proof; nothing is replayed
`

export async function runRecoveryCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'recovery') return undefined
  if (action === 'list') {
    if (rest.some((word) => word !== '--open') || rest.length > 1) {
      throw new CliError('usage', 'recovery list accepts only --open.')
    }
    return dailyUseCommand(socketPath, { op: 'runtime.recovery', ...(rest.length ? { open_only: true } : {}) })
  }
  if (action === 'release' && rest.length === 2) {
    return dailyUseCommand(socketPath, { op: 'runtime.recovery.release',
      report_id: required(rest[0], 'REPORT_ID'), attempt_key: required(rest[1], 'ATTEMPT_KEY') })
  }
  return undefined
}
