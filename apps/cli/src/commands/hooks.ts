import { dailyUseCommand, type DailyUseRequest } from '@ade/client'
import { CliError, type CommandResult } from '../shared.js'

export const hookUsage = `  hook subscriptions                     List the lifecycle hooks live plugin activations subscribe to
  hook list [--status S] [--plugin PLUGIN_ID] [--after N] [--limit N]
                                        List hook deliveries in commit order, with plugin host status
  hook inspect EFFECT_ID                 Show one delivery
  hook retry EFFECT_ID --request-id ID [--acknowledge-unknown]
                                        Send a failed delivery again with the same effect ID; an
                                        unknown one needs --acknowledge-unknown
  hook abandon EFFECT_ID                 Stop a delivery that is not in flight
`

const statuses = ['awaiting_host', 'queued', 'dispatching', 'delivered', 'failed', 'unknown', 'abandoned'] as const
type Status = NonNullable<DailyUseRequest<'hook.delivery.list'>['status']>

function parse(words: string[], values: readonly string[], flags: readonly string[] = []) {
  const positionals: string[] = []
  const named: Record<string, string> = {}
  const set = new Set<string>()
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (flags.includes(word) && !set.has(word)) {
      set.add(word)
    } else if (values.includes(word) && named[word] === undefined) {
      const value = words[++index]
      if (!value || value.startsWith('--')) throw new CliError('usage', `${word} requires a value.`)
      named[word] = value
    } else if (word.startsWith('--')) {
      throw new CliError('usage', `Unknown or repeated option ${word}. Run ade --help for usage.`)
    } else {
      positionals.push(word)
    }
  }
  return { positionals, named, flags: set }
}

function count(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new CliError('usage', `${label} must be a nonnegative integer.`)
  }
  return number
}

function one(positionals: string[], usage: string): string {
  if (positionals.length !== 1) throw new CliError('usage', `${usage}.`)
  return positionals[0]
}

export async function runHookCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'hook') return undefined
  switch (action) {
    case 'subscriptions':
      if (rest.length) throw new CliError('usage', 'hook subscriptions takes no arguments.')
      return dailyUseCommand(socketPath, { op: 'hook.subscription.list' })
    case 'list': {
      const parsed = parse(rest, ['--status', '--plugin', '--after', '--limit'])
      if (parsed.positionals.length) throw new CliError('usage', 'hook list takes only options.')
      const status = parsed.named['--status']
      if (status !== undefined && !(statuses as readonly string[]).includes(status)) {
        throw new CliError('usage', `--status must be one of ${statuses.join(', ')}.`)
      }
      const after = count(parsed.named['--after'], '--after')
      const limit = count(parsed.named['--limit'], '--limit')
      return dailyUseCommand(socketPath, { op: 'hook.delivery.list',
        ...(status ? { status: status as Status } : {}),
        ...(parsed.named['--plugin'] ? { plugin_id: parsed.named['--plugin'] } : {}),
        ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) })
    }
    case 'inspect':
    case 'abandon': {
      const effect_id = one(parse(rest, []).positionals, `hook ${action} requires EFFECT_ID`)
      const op = action === 'inspect' ? 'hook.delivery.inspect' : 'hook.delivery.abandon'
      return dailyUseCommand(socketPath, { op, effect_id })
    }
    case 'retry': {
      const parsed = parse(rest, ['--request-id'], ['--acknowledge-unknown'])
      const effect_id = one(parsed.positionals, 'hook retry requires EFFECT_ID --request-id ID')
      const operation_id = parsed.named['--request-id']
      if (!operation_id || operation_id.length > 256) {
        throw new CliError('usage', 'hook retry requires --request-id ID (1 to 256 characters); reuse it only to repeat the same retry.')
      }
      return dailyUseCommand(socketPath, { op: 'hook.delivery.retry', effect_id, operation_id,
        ...(parsed.flags.has('--acknowledge-unknown') ? { acknowledge_unknown: true } : {}) })
    }
    default:
      throw new CliError('usage', 'Unknown hook command. Run ade --help for usage.')
  }
}
