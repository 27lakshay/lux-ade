// Pure placement and preview-capability decisions on the client side
// (F127, F129; architecture section 9).
//
// The daemon's `placement.check` decides from its own evidence: the registry,
// the pairing and the last remote start. Only the client's remote transport
// knows whether the link to that host is up right now, so the final admission
// combines the two here. Rules:
// - The host is the one the caller named. Nothing here returns another host,
//   and no refusal is turned into local execution.
// - A remote preview is forwarded over SSH only for a loopback service on that
//   remote host, and only while its transport is connected.
// - Remote device and computer control is not offered, and never falls back to
//   a device on this machine.
// Pattern studied, not copied: Orca src/main/ssh/ssh-port-forward.ts and
// system-ssh-port-forward-provider.ts (MIT): bind the local end to 127.0.0.1.
import type { ExecutionHost, ExecutionHostEntry, PlacementDecision } from '@ade/contracts'
import { connectionKey, hostTrustArgs, validateTarget, type RemoteState, type RemoteTarget } from './remote-state.js'

export type PlacementAdmission =
  | { admitted: true; host: ExecutionHost; via: 'local_daemon' | 'remote_transport' }
  | { admitted: false; host: ExecutionHost; reason: string }

function hostName(host: ExecutionHost): string {
  return host.kind === 'local' ? 'this Mac' : `remote host ${host.host_id}`
}

/** Why the connection cannot carry work for `host` now, or null when it can. */
function transportRefusal(host: Extract<ExecutionHost, { kind: 'remote' }>, connection: RemoteState | null,
  target: RemoteTarget | null): string | null {
  if (!target || !connection) return `No remote transport is open to ${host.host_id}.`
  if (target.hostId !== host.host_id) return `The open remote transport reaches ${target.hostId}, not ${host.host_id}.`
  const invalid = validateTarget(target)
  if (invalid) return invalid
  if (connection.key !== connectionKey(target)) return 'The connection state belongs to a different host or profile.'
  if (connection.phase !== 'connected' || !connection.current) {
    return connection.phase === 'unknown'
      ? `The link to ${host.host_id} was lost; its state is unknown.`
      : `The remote transport to ${host.host_id} is not connected (${connection.phase}).`
  }
  return null
}

/**
 * Final admission for new work: the daemon's decision, then, for a remote
 * host, a connected transport to that same host. A refusal names the host the
 * caller chose and states that nothing was sent anywhere else.
 */
export function admitPlacement(decision: PlacementDecision, connection: RemoteState | null,
  target: RemoteTarget | null): PlacementAdmission {
  const host = decision.host
  const refuse = (reason: string): PlacementAdmission =>
    ({ admitted: false, host, reason: `${reason} Nothing was sent to another host.` })
  if (!decision.admitted) return refuse(decision.reason ?? `${hostName(host)} refused the placement.`)
  if (host.kind === 'local') {
    if (target || connection) return refuse('A local placement does not use a remote transport.')
    return { admitted: true, host, via: 'local_daemon' }
  }
  const refusal = transportRefusal(host, connection, target)
  if (refusal) return refuse(refusal)
  return { admitted: true, host, via: 'remote_transport' }
}

export interface PreviewCapability {
  host: ExecutionHost
  url: string
  /** How the preview reaches this machine; `none` when it cannot. */
  transport: 'direct' | 'ssh_forward' | 'none'
  /** Whether this host and URL can be previewed at all. */
  supported: boolean
  /** Whether it can be previewed now. */
  available: boolean
  /** For an SSH forward: the address the remote end connects to on that host. */
  remoteHost: string | null
  remotePort: number | null
  reason: string | null
}

export interface DeviceCapability {
  host: ExecutionHost
  access: 'local_host' | 'unsupported'
  /** False when unsupported; null when each local device reports its own availability. */
  available: false | null
  reason: string
}

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** The address to forward to on the remote host, or null when the URL is not its own loopback. */
function remoteLoopback(hostname: string): string | null {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '0.0.0.0') return '127.0.0.1'
  if (LOOPBACK_V4.test(host)) return host
  // WHATWG URL keeps IPv6 brackets in `hostname`.
  if (host === '[::1]' || host === '[::]') return '::1'
  return null
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80
}

/**
 * Whether a service URL on `entry`'s host can be previewed from this machine.
 * On a remote host it is forwarded over the remote SSH transport only when it
 * is a loopback http(s) URL on that host and the transport is connected. A
 * URL that names another machine is not forwarded: ADE would be reaching a
 * third host the user did not choose.
 */
export function previewCapability(entry: ExecutionHostEntry, url: string, connection: RemoteState | null,
  target: RemoteTarget | null): PreviewCapability {
  const host = entry.host
  const report = (fields: Partial<PreviewCapability>): PreviewCapability => ({
    host, url, transport: 'none', supported: false, available: false, remoteHost: null, remotePort: null,
    reason: null, ...fields,
  })
  let parsed: URL
  try { parsed = new URL(url) } catch { return report({ reason: 'The preview URL is not a valid URL.' }) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return report({ reason: 'Only http and https previews are supported.' })
  }
  if (parsed.username || parsed.password) {
    return report({ reason: 'A preview URL must not carry credentials.' })
  }
  if (host.kind === 'local') {
    if (entry.capabilities.previews !== 'direct') {
      return report({ reason: 'This Mac does not report a direct preview transport.' })
    }
    return report({ transport: 'direct', supported: true, available: true })
  }
  if (entry.capabilities.previews !== 'ssh_forward') {
    return report({ reason: `${host.host_id} offers no preview transport.` })
  }
  const remoteHost = remoteLoopback(parsed.hostname)
  if (!remoteHost) {
    return report({ reason: `${parsed.hostname} is not ${host.host_id}'s own loopback address; ` +
      'only services listening on that host are forwarded.' })
  }
  const remotePort = parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol)
  const forward = { transport: 'ssh_forward' as const, supported: true, remoteHost, remotePort }
  if (entry.readiness !== 'started') {
    return report({ ...forward, reason: entry.reason ?? `${host.host_id} is not started.` })
  }
  const refusal = transportRefusal(host, connection, target)
  if (refusal) return report({ ...forward, reason: refusal })
  return report({ ...forward, available: true })
}

/** Device and computer control on a host. Remote access is never redirected to a local device. */
export function deviceCapability(entry: ExecutionHostEntry): DeviceCapability {
  if (entry.host.kind === 'local' && entry.capabilities.devices === 'local_host') {
    return { host: entry.host, access: 'local_host', available: null,
      reason: 'Devices attached to this Mac each report their own availability.' }
  }
  return { host: entry.host, access: 'unsupported', available: false,
    reason: `Device and computer control is not supported on ${hostName(entry.host)}; ` +
      'nothing is redirected to a device on this Mac.' }
}

function validPort(port: number, min: number): boolean {
  return Number.isInteger(port) && port >= min && port <= 65535
}

/**
 * OpenSSH arguments for `ssh -L 127.0.0.1:localPort:remoteHost:remotePort`.
 * The local end binds loopback only; the remote end must be the remote host's
 * own loopback address from {@link previewCapability}. Hardened like the
 * daemon socket forward: strict host keys (only the pinned key when the target
 * pins one), no prompts, no agent forwarding.
 */
export function sshPreviewForwardArgs(target: RemoteTarget, capability: PreviewCapability,
  localPort: number, knownHostsFile: string | null): string[] {
  const invalid = validateTarget(target)
  if (invalid) throw new TypeError(invalid)
  if (capability.host.kind !== 'remote' || capability.host.host_id !== target.hostId) {
    throw new TypeError('The preview belongs to a different host than this transport.')
  }
  if (capability.transport !== 'ssh_forward' || !capability.available || capability.remoteHost === null ||
    capability.remotePort === null) {
    throw new TypeError(capability.reason ?? 'This preview cannot be forwarded.')
  }
  if (!validPort(capability.remotePort, 1)) throw new TypeError('Remote port must be from 1 to 65535.')
  if (!validPort(localPort, 1024)) throw new TypeError('Local port must be from 1024 to 65535.')
  const remote = capability.remoteHost.includes(':') ? `[${capability.remoteHost}]` : capability.remoteHost
  return [
    '-N', '-T',
    ...hostTrustArgs(target, knownHostsFile),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-L', `127.0.0.1:${localPort}:${remote}:${capability.remotePort}`,
    '--', target.destination,
  ]
}
