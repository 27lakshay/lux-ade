import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const retentionUsage = `  retention preview                     List what retention would remove now, with its generation
  retention apply GENERATION            Remove exactly the previewed set; a changed set is refused
  retention policy                      Show the retention policy and its revision
  retention policy set REVISION [--service-log-idle-days N] [--diagnostic-log-days N]
                                        Configure the limits (1 to 365 days); an omitted limit returns to its default
`

const DAY_MS = 24 * 60 * 60 * 1000

function days(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new CliError('usage', `${flag} takes a whole number of days.`)
  return Number(value) * DAY_MS
}

export async function runRetentionCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'retention') return undefined
  if (action === 'preview' && rest.length === 0) {
    return dailyUseCommand(socketPath, { op: 'retention.preview' })
  }
  if (action === 'apply' && rest.length === 1) {
    return dailyUseCommand(socketPath, { op: 'retention.apply', generation: required(rest[0], 'GENERATION') })
  }
  if (action === 'policy' && rest.length === 0) {
    return dailyUseCommand(socketPath, { op: 'retention.policy.get' })
  }
  if (action === 'policy' && rest[0] === 'set') {
    const revision = required(rest[1], 'REVISION')
    if (!/^\d+$/.test(revision)) throw new CliError('usage', 'REVISION is the policy revision retention policy showed.')
    const options = namedOptions(
      rest.slice(2),
      ['--service-log-idle-days', '--diagnostic-log-days'],
      'retention policy set',
    )
    const serviceLog = days(options['--service-log-idle-days'], '--service-log-idle-days')
    const diagnosticLog = days(options['--diagnostic-log-days'], '--diagnostic-log-days')
    return dailyUseCommand(socketPath, {
      op: 'retention.policy.set',
      expected_revision: Number(revision),
      ...(serviceLog === undefined ? {} : { service_log_idle_ms: serviceLog }),
      ...(diagnosticLog === undefined ? {} : { diagnostic_log_max_age_ms: diagnosticLog }),
    })
  }
  return undefined
}
