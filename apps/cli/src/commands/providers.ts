import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const providerUsage = `  provider list                         List the providers this build supports
  provider capabilities [PROVIDER]      Show what each provider offers and what ADE can select;
                                        native_only and unknown are never treated as supported
  provider readiness PROVIDER [--account ID]
                                        Check the executables, and with an account its version,
                                        sign-in and pinned identity
  provider quota [--provider ID] [--account ID]
                                        Show reported limits per account with their age;
                                        ADE never switches account or model on exhaustion
  provider registrations                 List every registered provider and its origin:
                                        bundled, adapter or plugin worker version
  preset list                           List presets with capability conflicts
  preset show NAME                       Show one preset with capability conflicts
  preset save NAME --provider ID [--model MODEL] [--reasoning LEVEL] [--permission MODE]
              [--expected-revision N]    Create a preset, or replace the revision given
  preset delete NAME --expected-revision N
                                        Delete a preset at the revision you last saw
`

function revision(value: string): number {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new CliError('usage', '--expected-revision must be a positive integer.')
  }
  return number
}

async function runProvider(
  socketPath: string,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (action === 'list') {
    if (rest.length) throw new CliError('usage', 'provider list does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'provider.list' })
  }
  if (action === 'capabilities') {
    if (rest.length > 1) throw new CliError('usage', 'provider capabilities accepts at most one PROVIDER.')
    return dailyUseCommand(socketPath, { op: 'provider.capabilities', ...(rest[0] ? { provider: rest[0] } : {}) })
  }
  if (action === 'registrations') {
    if (rest.length) throw new CliError('usage', 'provider registrations does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'provider.registrations' })
  }
  if (action === 'readiness') {
    const provider = required(rest[0], 'PROVIDER')
    const options = namedOptions(rest.slice(1), ['--account'], 'provider readiness')
    return dailyUseCommand(socketPath, {
      op: 'provider.readiness',
      provider,
      ...(options['--account'] !== undefined ? { account_id: options['--account'] } : {}),
    })
  }
  if (action === 'quota') {
    const options = namedOptions(rest, ['--provider', '--account'], 'provider quota')
    return dailyUseCommand(socketPath, {
      op: 'provider.quota',
      ...(options['--provider'] !== undefined ? { provider: options['--provider'] } : {}),
      ...(options['--account'] !== undefined ? { account_id: options['--account'] } : {}),
    })
  }
  return undefined
}

async function runPreset(
  socketPath: string,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (action === 'list') {
    if (rest.length) throw new CliError('usage', 'preset list does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'preset.list' })
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new CliError('usage', 'preset show requires NAME.')
    return dailyUseCommand(socketPath, { op: 'preset.get', name: required(rest[0], 'NAME') })
  }
  if (action === 'save') {
    const name = required(rest[0], 'NAME')
    const options = namedOptions(
      rest.slice(1),
      ['--provider', '--model', '--reasoning', '--permission', '--expected-revision'],
      'preset save',
    )
    return dailyUseCommand(socketPath, {
      op: 'preset.save',
      name,
      provider: required(options['--provider'], '--provider'),
      ...(options['--model'] !== undefined ? { model: options['--model'] } : {}),
      ...(options['--reasoning'] !== undefined ? { reasoning: options['--reasoning'] } : {}),
      ...(options['--permission'] !== undefined ? { permission_mode: options['--permission'] } : {}),
      ...(options['--expected-revision'] !== undefined
        ? { expected_revision: revision(options['--expected-revision']) }
        : {}),
    })
  }
  if (action === 'delete') {
    const name = required(rest[0], 'NAME')
    const options = namedOptions(rest.slice(1), ['--expected-revision'], 'preset delete')
    return dailyUseCommand(socketPath, {
      op: 'preset.delete',
      name,
      expected_revision: revision(required(options['--expected-revision'], '--expected-revision')),
    })
  }
  return undefined
}

export async function runProviderCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area === 'provider') return runProvider(socketPath, action, rest)
  if (area === 'preset') return runPreset(socketPath, action, rest)
  return undefined
}
