import { dailyUseCommand, type DailyUseRequest, type DailyUseResponse } from '@ade/client'
import {
  deviceCapability, previewCapability, RemoteDaemonTransport, validateTarget, type RemoteTarget,
} from '@ade/client/remote'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const placementUsage = `  placement hosts                       List execution hosts with readiness and capabilities
  placement check HOST KIND [--workspace ID]
                                        Ask whether new KIND work may run on HOST (local or a remote
                                        host ID); a refusal exits not_applied and names no other host
  placement record HOST KIND WORKSPACE_ID [ID|NAME]
                                        Record the remote host of a resource created there
  placement resolve KIND WORKSPACE_ID [ID|NAME]
                                        Show a resource's execution host
  placement list [--host ID]            List recorded remote placements
  placement release KIND WORKSPACE_ID [ID|NAME]
                                        Forget the record of a remote resource that no longer exists
  placement preview HOST URL [--timeout-ms N]
                                        Report whether URL on HOST can be previewed here, and whether
                                        HOST offers device control; connects to a started remote host
                                        KIND is workspace, conversation, terminal or service
`

type Host = DailyUseRequest<'placement.check'>['host']
type Kind = DailyUseRequest<'placement.check'>['resource']
type Resource = DailyUseRequest<'placement.resolve'>['resource']
type HostEntry = DailyUseResponse<'placement.hosts'>['hosts'][number]

const kinds: readonly Kind[] = ['workspace', 'conversation', 'terminal', 'service']

function host(value: string | undefined): Host {
  const id = required(value, 'HOST')
  return id === 'local' ? { kind: 'local' } : { kind: 'remote', host_id: id }
}

function kind(value: string | undefined): Kind {
  const found = kinds.find((candidate) => candidate === value)
  if (!found) throw new CliError('usage', 'KIND must be workspace, conversation, terminal or service.')
  return found
}

function resource(words: string[], command: string): Resource {
  const [kindWord, workspace, key, ...extra] = words
  const workspace_id = required(workspace, 'WORKSPACE_ID')
  const resourceKind = kind(kindWord)
  if (extra.length || (resourceKind === 'workspace') !== (key === undefined)) {
    throw new CliError('usage', `placement ${command} takes KIND WORKSPACE_ID, plus ID or NAME unless KIND is workspace.`)
  }
  switch (resourceKind) {
    case 'workspace': return { kind: 'workspace', workspace_id }
    case 'conversation': return { kind: 'conversation', workspace_id, conversation_id: required(key, 'ID') }
    case 'terminal': return { kind: 'terminal', workspace_id, terminal_id: required(key, 'ID') }
    case 'service': return { kind: 'service', workspace_id, name: required(key, 'NAME') }
  }
}

function timeout(options: Record<string, string>): number {
  const value = Number(options['--timeout-ms'] ?? 30_000)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new CliError('usage', '--timeout-ms must be an integer from 1000 to 300000.')
  }
  return value
}

/** The remote transport target for a started host, from the registry and its last start. */
async function remoteTarget(socketPath: string, entry: HostEntry): Promise<RemoteTarget | null> {
  if (entry.host.kind !== 'remote' || entry.readiness !== 'started' || !entry.remote_socket ||
    !entry.remote_profile_id) return null
  const hostId = entry.host.host_id
  const { hosts } = await dailyUseCommand<'remote.host.list'>(socketPath, { op: 'remote.host.list' })
  const registered = hosts.find((candidate) => candidate.host_id === hostId)
  if (!registered) return null
  // The daemon pinned this key; the forward trusts only it, never the user's known_hosts.
  const target = { hostId, profileId: entry.remote_profile_id, destination: registered.ssh_target,
    remoteSocket: entry.remote_socket, hostPublicKey: registered.host_public_key }
  return validateTarget(target) ? null : target
}

async function preview(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [hostWord, url, ...optionWords] = rest
  const chosen = host(hostWord)
  const address = required(url, 'URL')
  const deadline = timeout(namedOptions(optionWords, ['--timeout-ms'], 'placement preview'))
  const { hosts } = await dailyUseCommand<'placement.hosts'>(socketPath, { op: 'placement.hosts' })
  const entry = hosts.find((candidate) => candidate.host.kind === chosen.kind &&
    (candidate.host.kind === 'local' || (chosen.kind === 'remote' && candidate.host.host_id === chosen.host_id)))
  if (!entry) throw new CliError('not_applied', `${hostWord} is not a registered execution host.`)
  const devices = deviceCapability(entry)
  const target = await remoteTarget(socketPath, entry)
  if (!target) {
    return { type: 'placement_preview', preview: previewCapability(entry, address, null, null), devices }
  }
  const transport = new RemoteDaemonTransport(target, { forwardTimeoutMs: deadline })
  try {
    transport.start()
    // A failed connection is reported as an unavailable preview, not an error.
    await transport.waitUntilConnected(deadline).catch(() => undefined)
    return { type: 'placement_preview', preview: transport.previewCapability(entry, address), devices }
  } finally {
    transport.dispose()
  }
}

export async function runPlacementCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'placement') return undefined
  switch (action) {
    case 'hosts':
      if (rest.length) throw new CliError('usage', 'placement hosts does not accept arguments.')
      return dailyUseCommand(socketPath, { op: 'placement.hosts' })
    case 'check': {
      const [hostWord, kindWord, ...optionWords] = rest
      const options = namedOptions(optionWords, ['--workspace'], 'placement check')
      const decision = await dailyUseCommand<'placement.check'>(socketPath, { op: 'placement.check', host: host(hostWord),
        resource: kind(kindWord), ...(options['--workspace'] ? { workspace_id: options['--workspace'] } : {}) })
      if (!decision.admitted) throw new CliError('not_applied', decision.reason ?? 'Placement refused.')
      return decision
    }
    case 'record': {
      const [hostWord, ...words] = rest
      return dailyUseCommand(socketPath, { op: 'placement.record', host: host(hostWord),
        resource: resource(words, 'record') })
    }
    case 'resolve':
      return dailyUseCommand(socketPath, { op: 'placement.resolve', resource: resource(rest, 'resolve') })
    case 'release':
      return dailyUseCommand(socketPath, { op: 'placement.release', resource: resource(rest, 'release') })
    case 'list': {
      const options = namedOptions(rest, ['--host'], 'placement list')
      return dailyUseCommand(socketPath, { op: 'placement.list',
        ...(options['--host'] ? { host_id: options['--host'] } : {}) })
    }
    case 'preview':
      return preview(socketPath, rest)
    default:
      return undefined
  }
}
