import { dailyUseCommand, type DailyUseRequest } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const resourcesUsage = `  resources inspect [--path PATH] [--kind checkout|port|device]
                                        List host-wide claims on checkouts, service ports and devices
                                        across every profile on this host
  resources resolve CLAIM_ID CONFIRM --request-id ID
                                        Release one quarantined claim after checking the resource yourself;
                                        CONFIRM is the claim's path, tcp:PORT or device ID
  resources accept REGISTRY_PATH --request-id ID
                                        Bind this profile to a replaced, missing or unreadable registry
  resources device hold DEVICE HOLDER   Hold a simulator or emulator exclusively for one run
  resources device release DEVICE HOLDER
                                        End that run's hold
`

type Kind = NonNullable<DailyUseRequest<'resources.inspect'>['resource']>
const kinds: readonly Kind[] = ['checkout', 'port', 'device']

function positional(rest: string[], count: number, command: string): string[] {
  const words = rest.slice(0, count)
  if (words.length < count || words.some((word) => word.startsWith('--'))) {
    throw new CliError('usage', `resources ${command} is missing arguments. Run ade --help for usage.`)
  }
  return words
}

/** HostResources commands: inspect claims, recover explicitly and hold devices for a run. */
export async function runResourcesCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'resources') return undefined
  switch (action) {
    case 'inspect': {
      const options = namedOptions(rest, ['--path', '--kind'], 'resources inspect')
      const kind = options['--kind']
      if (kind !== undefined && !kinds.includes(kind as Kind)) {
        throw new CliError('usage', `--kind takes ${kinds.join(', ')}.`)
      }
      return dailyUseCommand(socketPath, { op: 'resources.inspect', ...(options['--path'] ? { path: options['--path'] } : {}),
        ...(kind ? { resource: kind as Kind } : {}) })
    }
    case 'resolve': {
      const [claim, confirm] = positional(rest, 2, 'resolve')
      const options = namedOptions(rest.slice(2), ['--request-id'], 'resources resolve')
      return dailyUseCommand(socketPath, { op: 'resources.claim.resolve',
        operation_id: required(options['--request-id'], '--request-id'), claim_id: required(claim, 'CLAIM_ID'),
        confirm_path: required(confirm, 'CONFIRM') })
    }
    case 'accept': {
      const [registry] = positional(rest, 1, 'accept')
      const options = namedOptions(rest.slice(1), ['--request-id'], 'resources accept')
      return dailyUseCommand(socketPath, { op: 'resources.registry.accept',
        operation_id: required(options['--request-id'], '--request-id'), confirm_registry: required(registry, 'REGISTRY_PATH') })
    }
    case 'device': {
      const [verb, device, holder, ...extra] = rest
      if (extra.length) throw new CliError('usage', `resources device ${verb ?? ''} takes DEVICE HOLDER.`)
      const fields = { device_id: required(device, 'DEVICE'), holder: required(holder, 'HOLDER') }
      if (verb === 'hold') return dailyUseCommand(socketPath, { op: 'resources.device.hold', ...fields })
      if (verb === 'release') return dailyUseCommand(socketPath, { op: 'resources.device.release', ...fields })
      throw new CliError('usage', 'resources device takes hold or release.')
    }
    default:
      throw new CliError('usage', 'resources takes inspect, resolve, accept or device. Run ade --help for usage.')
  }
}
