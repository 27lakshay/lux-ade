import { dailyUseCommand, type DailyUseRequest } from '@ade/client'
import { CliError, required, type CommandResult } from '../shared.js'

export const adapterUsage = `  adapter list                          List this profile's generic ACP and custom executable
                                        adapters, with revision, probe and readiness
  adapter set ID --name NAME --kind acp|executable --command ABSOLUTE_PATH
              [--arg ARG]... [--env NAME=VALUE]... [--prompt-input stdin|argument]
              [--timeout SECONDS] [--expected-revision N]
                                        Create or replace an adapter; --arg takes the next word
                                        verbatim. Executables need --prompt-input and --timeout.
                                        Credential-like environment names are refused.
  adapter probe ID [--expected-revision N]
                                        ACP: launch the agent, read its declared capabilities
                                        from initialize, then stop it. Executable: check the
                                        file without running it
  adapter remove ID                     Delete an adapter definition and its probe
`

function revision(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliError('usage', '--expected-revision must be a non-negative integer.')
  }
  return number
}

function parseSet(id: string, words: string[]): DailyUseRequest<'adapter.put'> {
  const single: Record<string, string> = {}
  const args: string[] = []
  const env: Record<string, string> = {}
  for (let index = 0; index < words.length; index += 2) {
    const key = words[index]
    const value = words[index + 1]
    if (value === undefined) throw new CliError('usage', `${key} requires a value. Run ade --help for usage.`)
    if (key === '--arg') {
      args.push(value)
      continue
    }
    if (key === '--env') {
      const split = value.indexOf('=')
      if (split <= 0) throw new CliError('usage', '--env takes NAME=VALUE.')
      const name = value.slice(0, split)
      if (env[name] !== undefined) throw new CliError('usage', `--env ${name} is given twice.`)
      env[name] = value.slice(split + 1)
      continue
    }
    const allowed = ['--name', '--kind', '--command', '--prompt-input', '--timeout', '--expected-revision']
    if (!allowed.includes(key) || value.startsWith('--') || single[key] !== undefined) {
      throw new CliError('usage', 'Invalid adapter set option. Run ade --help for usage.')
    }
    single[key] = value
  }
  const kind = required(single['--kind'], '--kind')
  if (kind !== 'acp' && kind !== 'executable') throw new CliError('usage', '--kind must be acp or executable.')
  let executable: { prompt_input: 'stdin' | 'argument'; timeout_seconds: number } | undefined
  if (kind === 'executable') {
    const input = required(single['--prompt-input'], '--prompt-input')
    if (input !== 'stdin' && input !== 'argument') {
      throw new CliError('usage', '--prompt-input must be stdin or argument.')
    }
    const timeout = Number(required(single['--timeout'], '--timeout'))
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) {
      throw new CliError('usage', '--timeout must be an integer from 1 to 3600.')
    }
    executable = { prompt_input: input, timeout_seconds: timeout }
  } else if (single['--prompt-input'] !== undefined || single['--timeout'] !== undefined) {
    throw new CliError('usage', '--prompt-input and --timeout apply only to --kind executable.')
  }
  return {
    op: 'adapter.put',
    definition: {
      id,
      name: required(single['--name'], '--name'),
      kind,
      command: required(single['--command'], '--command'),
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(executable ? { executable } : {}),
    },
    ...(single['--expected-revision'] !== undefined
      ? { expected_revision: revision(single['--expected-revision']) }
      : {}),
  }
}

export async function runAdapterCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'adapter') return undefined
  if (action === 'list' && rest.length === 0) return dailyUseCommand(socketPath, { op: 'adapter.list' })
  if (action === 'set' && rest.length >= 1) {
    return dailyUseCommand(socketPath, parseSet(required(rest[0], 'ID'), rest.slice(1)))
  }
  if (action === 'probe' && (rest.length === 1 || rest.length === 3)) {
    const id = required(rest[0], 'ID')
    if (rest.length === 3 && rest[1] !== '--expected-revision') {
      throw new CliError('usage', 'Invalid adapter probe option. Run ade --help for usage.')
    }
    return dailyUseCommand(socketPath, {
      op: 'adapter.probe',
      id,
      ...(rest.length === 3 ? { expected_revision: revision(rest[2]) } : {}),
    })
  }
  if (action === 'remove' && rest.length === 1) {
    return dailyUseCommand(socketPath, { op: 'adapter.remove', id: required(rest[0], 'ID') })
  }
  return undefined
}
