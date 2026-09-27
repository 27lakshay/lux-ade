import { readFileSync } from 'node:fs'
import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const remoteUsage = `  remote list                           List registered remote hosts and their pairings
  remote add HOST_ID SSH_TARGET FINGERPRINT [--label TEXT] [--host-key LINE|@FILE]
             [--backend-path PATH] [--remote-profile ID]
                                        Pin the host key matching FINGERPRINT (SHA256:...)
  remote remove HOST_ID                 Forget a host with no active pairing; the host is untouched
  remote probe HOST_ID                  Verify the host key and report what the ADE backend lacks
  remote pair HOST_ID (--token-env NAME | --token-keychain SERVICE --token-account ACCOUNT)
                                        Record a pairing; only the token's location is stored
  remote revoke HOST_ID PAIRING_ID      Revoke a pairing; this profile stops starting the host
  remote start HOST_ID --request-id ID  Start or attach the remote profile daemon
`

function split(rest: string[], positional: number, allowed: readonly string[], command: string):
  { args: string[]; options: Record<string, string> } {
  if (rest.length < positional) throw new CliError('usage', `remote ${command} is missing arguments. Run ade --help for usage.`)
  return { args: rest.slice(0, positional), options: namedOptions(rest.slice(positional), allowed, `remote ${command}`) }
}

function hostKey(value: string): string {
  if (!value.startsWith('@')) return value
  try { return readFileSync(value.slice(1), 'utf8').trim() }
  catch { throw new CliError('usage', `Cannot read host key file ${value.slice(1)}.`) }
}

type TokenReference = { env: string } | { keychain: { service: string; account: string } }

function tokenReference(options: Record<string, string>): TokenReference {
  const env = options['--token-env']
  const service = options['--token-keychain']
  const account = options['--token-account']
  if (env && !service && !account) return { env }
  if (!env && service && account) return { keychain: { service, account } }
  throw new CliError('usage', 'remote pair takes --token-env NAME, or --token-keychain SERVICE with --token-account ACCOUNT.')
}

export async function runRemoteCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'remote') return undefined
  switch (action) {
    case 'list':
      if (rest.length) throw new CliError('usage', 'remote list does not accept arguments.')
      return dailyUseCommand(socketPath, { op: 'remote.host.list' })
    case 'add': {
      const { args, options } = split(rest, 3,
        ['--label', '--host-key', '--backend-path', '--remote-profile'], 'add')
      return dailyUseCommand(socketPath, { op: 'remote.host.add',
        host_id: required(args[0], 'HOST_ID'), ssh_target: required(args[1], 'SSH_TARGET'),
        expected_fingerprint: required(args[2], 'FINGERPRINT'),
        ...(options['--label'] ? { label: options['--label'] } : {}),
        ...(options['--host-key'] ? { host_public_key: hostKey(options['--host-key']) } : {}),
        ...(options['--backend-path'] ? { backend_path: options['--backend-path'] } : {}),
        ...(options['--remote-profile'] ? { remote_profile_id: options['--remote-profile'] } : {}) })
    }
    case 'remove':
    case 'probe': {
      const { args } = split(rest, 1, [], action)
      if (rest.length !== 1) throw new CliError('usage', `remote ${action} takes HOST_ID only.`)
      return dailyUseCommand(socketPath, { op: action === 'remove' ? 'remote.host.remove' : 'remote.host.probe',
        host_id: required(args[0], 'HOST_ID') })
    }
    case 'pair': {
      const { args, options } = split(rest, 1, ['--token-env', '--token-keychain', '--token-account'], 'pair')
      return dailyUseCommand(socketPath, { op: 'remote.host.pair', host_id: required(args[0], 'HOST_ID'),
        token_reference: tokenReference(options) })
    }
    case 'revoke': {
      if (rest.length !== 2) throw new CliError('usage', 'remote revoke takes HOST_ID PAIRING_ID.')
      return dailyUseCommand(socketPath, { op: 'remote.host.revoke',
        host_id: required(rest[0], 'HOST_ID'), pairing_id: required(rest[1], 'PAIRING_ID') })
    }
    case 'start': {
      const { args, options } = split(rest, 1, ['--request-id'], 'start')
      const reply = await dailyUseCommand(socketPath, { op: 'remote.host.start',
        host_id: required(args[0], 'HOST_ID'), operation_id: required(options['--request-id'], '--request-id') })
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'unknown') throw new CliError('outcome_unknown', detail ?? 'Remote start outcome is unknown.')
      if (reply.outcome === 'failed') throw new CliError('not_applied', detail ?? 'Remote start failed.')
      return reply
    }
    default:
      return undefined
  }
}
