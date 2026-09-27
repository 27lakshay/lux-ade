import { call, type DailyUseRequest } from '@ade/client'
import { boundedInteger, CliError, parseWords, positionals, type CommandResult } from '../shared.js'

export const activityUsage = `  activity list [--unread] [--include-dismissed] [--limit 1..200] [--before SEQ | --after SEQ]
                                        List the activity inbox, newest first; --after catches up oldest first
  activity mark read|dismissed ACTIVITY_ID...
                                        Mark activity read or dismissed; reports each one's current state
  notification deliveries [--status claimed|shown|failed|suppressed] [--limit 1..200]
                                        List OS notification deliveries, newest first; claimed means unknown
`

const deliveryStatuses = ['claimed', 'shown', 'failed', 'suppressed'] as const
type DeliveryStatus = (typeof deliveryStatuses)[number]

export async function runActivityCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'activity' && action === 'list') {
    const parsed = parseWords(rest, ['--limit', '--before', '--after'], ['--unread', '--include-dismissed'], 'activity list')
    positionals(parsed, 0, 'activity list accepts only options')
    const { '--limit': limit, '--before': before, '--after': after } = parsed.options
    if (before !== undefined && after !== undefined) throw new CliError('usage', 'Use --before or --after, not both.')
    return call(socketPath, 'activity.list', {
      ...(limit === undefined ? {} : { limit: boundedInteger(limit, 'LIMIT', 1, 200) }),
      ...(before === undefined ? {} : { before: boundedInteger(before, 'SEQ', 0, Number.MAX_SAFE_INTEGER) }),
      ...(after === undefined ? {} : { after: boundedInteger(after, 'SEQ', 0, Number.MAX_SAFE_INTEGER) }),
      ...(parsed.flags.has('--unread') ? { unread_only: true } : {}),
      ...(parsed.flags.has('--include-dismissed') ? { include_dismissed: true } : {}),
    })
  }
  if (area === 'activity' && action === 'mark') {
    const [mark, ...ids] = parseWords(rest, [], [], 'activity mark').positionals
    if ((mark !== 'read' && mark !== 'dismissed') || ids.length === 0 || ids.some((id) => !id)) {
      throw new CliError('usage', 'activity mark requires read|dismissed ACTIVITY_ID....')
    }
    return call(socketPath, 'activity.mark', { mark, activity_ids: ids })
  }
  if (area === 'notification' && action === 'deliveries') {
    const parsed = parseWords(rest, ['--status', '--limit'], [], 'notification deliveries')
    positionals(parsed, 0, 'notification deliveries accepts only options')
    const { '--status': status, '--limit': limit } = parsed.options
    if (status !== undefined && !deliveryStatuses.includes(status as DeliveryStatus)) {
      throw new CliError('usage', `--status must be one of ${deliveryStatuses.join(', ')}.`)
    }
    const request: Omit<DailyUseRequest<'notification.delivery.list'>, 'op'> = {
      ...(status === undefined ? {} : { status: status as DeliveryStatus }),
      ...(limit === undefined ? {} : { limit: boundedInteger(limit, 'LIMIT', 1, 200) }),
    }
    return call(socketPath, 'notification.delivery.list', request)
  }
  return undefined
}
