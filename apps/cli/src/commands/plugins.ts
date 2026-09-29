import { resolve } from 'node:path'
import { dailyUseCommand, type DailyUseRequest } from '@ade/client'
import { CliError, required, requiredOperationId, type CommandResult } from '../shared.js'

export const pluginUsage = `  plugin list                            List installed plugins with status and activation generation
  plugin inspect PLUGIN_ID              Show a plugin's manifest, source pin, artifact and registrations
  plugin install local PATH --operation-id ID [--version V]
  plugin install package ARCHIVE --operation-id ID [--sha256 HEX] [--version V]
  plugin install git URL --operation-id ID [--ref REF] [--commit SHA] [--version V]
                                        Install a pinned artifact; replacing one requires it disabled
  plugin uninstall PLUGIN_ID --operation-id ID [--purge-data]
                                        Remove a disabled plugin; records and settings stay unless purged
  plugin enable PLUGIN_ID               Start a new activation generation
  plugin disable PLUGIN_ID              End the activation and dispose only its registrations
  plugin record list PLUGIN_ID NAMESPACE
  plugin record get PLUGIN_ID NAMESPACE KEY
  plugin record put PLUGIN_ID NAMESPACE KEY JSON [--expected-revision N]
  plugin record delete PLUGIN_ID NAMESPACE KEY [--expected-revision N]
                                        Read and write the plugin's namespaced records
  plugin setting list PLUGIN_ID
  plugin setting set PLUGIN_ID KEY JSON
                                        Set a declared setting; null restores the default
  plugin invoke PLUGIN_ID COMMAND_ID --operation-id ID [--args JSON]
                                        Run a backend command; starts the plugin host on first use
  plugin host status PLUGIN_ID          Show the backend host's state, crashes, backoff and log tail
  plugin host restart PLUGIN_ID         Clear the crash count and start a fresh backend host
`

type Options = { positionals: string[]; values: Record<string, string>; flags: Set<string> }

function options(words: string[], valueNames: readonly string[], flagNames: readonly string[] = []): Options {
  const result: Options = { positionals: [], values: {}, flags: new Set() }
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (flagNames.includes(word)) {
      if (result.flags.has(word)) throw new CliError('usage', `${word} may be given once.`)
      result.flags.add(word)
    } else if (valueNames.includes(word)) {
      const value = words[++index]
      if (!value || value.startsWith('--') || result.values[word] !== undefined) {
        throw new CliError('usage', `${word} requires one value. Run ade --help for usage.`)
      }
      result.values[word] = value
    } else if (word.startsWith('--')) {
      throw new CliError('usage', `Unknown option ${word}. Run ade --help for usage.`)
    } else {
      result.positionals.push(word)
    }
  }
  return result
}

function revision(value: string | undefined): { expected_revision?: number } {
  if (value === undefined) return {}
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new CliError('usage', '--expected-revision must be a nonnegative integer.')
  }
  return { expected_revision: number }
}

function json(value: string | undefined, label: string): unknown {
  try {
    return JSON.parse(required(value, label))
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('usage', `${label} must be valid JSON.`)
  }
}

function count(parsed: Options, expected: number, usage: string): string[] {
  if (parsed.positionals.length !== expected) throw new CliError('usage', `${usage}.`)
  return parsed.positionals
}

function install(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [kind, ...tail] = rest
  const parsed = options(tail, ['--version', '--sha256', '--ref', '--commit'])
  const [locator] = count(parsed, 1, 'plugin install requires local PATH, package ARCHIVE or git URL')
  const operation_id = requiredOperationId()
  const version = parsed.values['--version']
  const extra = (allowed: string[]) => {
    for (const name of ['--sha256', '--ref', '--commit']) {
      if (parsed.values[name] !== undefined && !allowed.includes(name)) {
        throw new CliError('usage', `${name} does not apply to a ${kind} source.`)
      }
    }
  }
  let source: DailyUseRequest<'plugin.install'>['source']
  if (kind === 'local') {
    extra([])
    source = { kind: 'local', path: resolve(locator) }
  } else if (kind === 'package') {
    extra(['--sha256'])
    const sha256 = parsed.values['--sha256']
    source = { kind: 'package', path: resolve(locator), ...(sha256 ? { sha256 } : {}) }
  } else if (kind === 'git') {
    extra(['--ref', '--commit'])
    const ref = parsed.values['--ref']
    const commit = parsed.values['--commit']
    if (!ref && !commit) throw new CliError('usage', 'plugin install git requires --ref REF, --commit SHA or both.')
    source = { kind: 'git', url: locator, ...(ref ? { ref } : {}), ...(commit ? { commit } : {}) }
  } else {
    throw new CliError('usage', 'plugin install requires local, package or git.')
  }
  return dailyUseCommand(socketPath, {
    op: 'plugin.install',
    operation_id,
    source,
    ...(version ? { expected_version: version } : {}),
  })
}

function record(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [action, ...tail] = rest
  const parsed = options(tail, action === 'put' || action === 'delete' ? ['--expected-revision'] : [])
  if (action === 'list') {
    const [plugin_id, namespace] = count(parsed, 2, 'plugin record list requires PLUGIN_ID NAMESPACE')
    return dailyUseCommand(socketPath, { op: 'plugin.record.list', plugin_id, namespace })
  }
  if (action === 'get' || action === 'delete') {
    const [plugin_id, namespace, key] = count(parsed, 3, `plugin record ${action} requires PLUGIN_ID NAMESPACE KEY`)
    return action === 'get'
      ? dailyUseCommand(socketPath, { op: 'plugin.record.get', plugin_id, namespace, key })
      : dailyUseCommand(socketPath, {
          op: 'plugin.record.delete',
          plugin_id,
          namespace,
          key,
          ...revision(parsed.values['--expected-revision']),
        })
  }
  if (action === 'put') {
    const [plugin_id, namespace, key, value] = count(
      parsed,
      4,
      'plugin record put requires PLUGIN_ID NAMESPACE KEY JSON',
    )
    return dailyUseCommand(socketPath, {
      op: 'plugin.record.put',
      plugin_id,
      namespace,
      key,
      value: json(value, 'JSON'),
      ...revision(parsed.values['--expected-revision']),
    })
  }
  throw new CliError('usage', 'plugin record requires list, get, put or delete.')
}

function setting(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [action, ...tail] = rest
  const parsed = options(tail, [])
  if (action === 'list') {
    const [plugin_id] = count(parsed, 1, 'plugin setting list requires PLUGIN_ID')
    return dailyUseCommand(socketPath, { op: 'plugin.setting.list', plugin_id })
  }
  if (action === 'set') {
    const [plugin_id, key, value] = count(parsed, 3, 'plugin setting set requires PLUGIN_ID KEY JSON')
    return dailyUseCommand(socketPath, { op: 'plugin.setting.set', plugin_id, key, value: json(value, 'JSON') })
  }
  throw new CliError('usage', 'plugin setting requires list or set.')
}

function invoke(socketPath: string, rest: string[]): Promise<CommandResult> {
  const parsed = options(rest, ['--args'])
  const [plugin_id, command_id] = count(parsed, 2, 'plugin invoke requires PLUGIN_ID COMMAND_ID --operation-id ID')
  const operation_id = requiredOperationId()
  const args = parsed.values['--args']
  return dailyUseCommand(socketPath, {
    op: 'plugin.command.invoke',
    operation_id,
    plugin_id,
    command_id,
    ...(args === undefined ? {} : { args: json(args, '--args') }),
  })
}

function host(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [action, ...tail] = rest
  if (action !== 'status' && action !== 'restart')
    throw new CliError('usage', 'plugin host requires status or restart.')
  const [plugin_id] = count(options(tail, []), 1, `plugin host ${action} requires PLUGIN_ID`)
  return action === 'status'
    ? dailyUseCommand(socketPath, { op: 'plugin.host.status', plugin_id })
    : dailyUseCommand(socketPath, { op: 'plugin.host.restart', plugin_id })
}

export async function runPluginCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'plugin') return undefined
  switch (action) {
    case 'list':
      count(options(rest, []), 0, 'plugin list takes no arguments')
      return dailyUseCommand(socketPath, { op: 'plugin.list' })
    case 'inspect':
    case 'enable':
    case 'disable': {
      const [plugin_id] = count(options(rest, []), 1, `plugin ${action} requires PLUGIN_ID`)
      const op = ({ inspect: 'plugin.inspect', enable: 'plugin.enable', disable: 'plugin.disable' } as const)[action]
      return dailyUseCommand(socketPath, { op, plugin_id })
    }
    case 'install':
      return install(socketPath, rest)
    case 'uninstall': {
      const parsed = options(rest, [], ['--purge-data'])
      const [plugin_id] = count(parsed, 1, 'plugin uninstall requires PLUGIN_ID --operation-id ID')
      return dailyUseCommand(socketPath, {
        op: 'plugin.uninstall',
        plugin_id,
        operation_id: requiredOperationId(),
        ...(parsed.flags.has('--purge-data') ? { purge_data: true } : {}),
      })
    }
    case 'record':
      return record(socketPath, rest)
    case 'setting':
      return setting(socketPath, rest)
    case 'invoke':
      return invoke(socketPath, rest)
    case 'host':
      return host(socketPath, rest)
    default:
      throw new CliError('usage', 'Unknown plugin command. Run ade --help for usage.')
  }
}
