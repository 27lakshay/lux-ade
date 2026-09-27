import { RemoteDaemonTransport, validateTarget, type RemoteTarget } from '@ade/client/remote'
import { CliError, jsonObject, namedOptions, required, type CommandResult } from '../shared.js'

export const remoteConnectUsage = `  remote status --host ID --remote-profile ID --ssh DEST --remote-socket PATH [--host-key 'TYPE BASE64']
                                        Connect to a remote profile daemon through an SSH-forwarded
                                        socket and return its hello; never uses a local daemon.
                                        --host-key trusts only that key; without it ssh uses known_hosts
  remote request OP [JSON_OBJECT] --host ID --remote-profile ID --ssh DEST --remote-socket PATH [--host-key KEY]
                                        Send one command to the remote daemon; a lost reply is
                                        reported with delivery unknown and is not retried
      Both take [--pairing ID --token-env NAME] to present a pairing on the host's paired
      endpoint (remote start's daemon.paired_socket); the host refuses a revoked pairing
`

const targetOptions = [
  '--host',
  '--remote-profile',
  '--ssh',
  '--remote-socket',
  '--host-key',
  '--timeout-ms',
  '--pairing',
  '--token-env',
] as const

/** The pairing to present, with its token read from the named variable; never from the command line. */
function pairing(options: Record<string, string>): RemoteTarget['pairing'] {
  const pairingId = options['--pairing']
  const variable = options['--token-env']
  if (pairingId === undefined && variable === undefined) return null
  if (pairingId === undefined || variable === undefined) {
    throw new CliError('usage', '--pairing and --token-env are given together.')
  }
  const token = process.env[variable]
  if (!token) throw new CliError('usage', `The pairing token variable ${variable} is not set.`)
  return { pairingId, token }
}

function remoteTarget(options: Record<string, string>): RemoteTarget {
  const target = {
    hostId: required(options['--host'], '--host'),
    profileId: required(options['--remote-profile'], '--remote-profile'),
    destination: required(options['--ssh'], '--ssh'),
    remoteSocket: required(options['--remote-socket'], '--remote-socket'),
    hostPublicKey: options['--host-key'] ?? null,
    pairing: pairing(options),
  }
  const invalid = validateTarget(target)
  if (invalid) throw new CliError('usage', invalid)
  return target
}

function timeout(options: Record<string, string>): number {
  const value = Number(options['--timeout-ms'] ?? 30_000)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new CliError('usage', '--timeout-ms must be an integer from 1000 to 300000.')
  }
  return value
}

/** Remote commands take no local socket or profile: they only reach the named host. */
export async function runRemoteConnectCommand(words: string[]): Promise<CommandResult> {
  const [action, ...rest] = words
  let op: string | undefined
  let fields: Record<string, unknown> = {}
  let optionWords = rest
  if (action === 'request') {
    op = required(rest[0], 'OP')
    if (rest[1] !== undefined && !rest[1].startsWith('--')) {
      fields = jsonObject(rest[1], 'JSON_OBJECT')
      optionWords = rest.slice(2)
    } else optionWords = rest.slice(1)
  } else if (action !== 'status') {
    throw new CliError('usage', 'Unknown remote command. Run ade --help for usage.')
  }
  const options = namedOptions(optionWords, targetOptions, `remote ${action}`)
  const target = remoteTarget(options)
  const deadline = timeout(options)
  const transport = new RemoteDaemonTransport(target, { forwardTimeoutMs: deadline })
  try {
    transport.start()
    const state = await transport.waitUntilConnected(deadline)
    if (op === undefined) {
      const hello = await transport.request('hello', {}, { timeoutMs: deadline })
      return {
        type: 'remote_status',
        host_id: target.hostId,
        profile_id: target.profileId,
        runtime_socket: state.current?.runtimeSocket ?? null,
        hello,
      }
    }
    return await transport.request(op, fields, { timeoutMs: deadline })
  } finally {
    transport.dispose()
  }
}
