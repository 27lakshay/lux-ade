// Pure core of the remote transport: target validation, SSH forward arguments,
// SSH failure classification and the host-pinned reconnect state machine.
// Pattern studied, not copied: Orca src/main/ssh/system-ssh-forward-process.ts
// (MIT) and Herdr src/remote/restart_policy.rs (Apache-2.0).
//
// Rules this module enforces (architecture section 9, spec 11-remote):
// - A connection belongs to exactly one host and profile identity.
// - Link loss reports `unknown` and reconnects to that same target only.
// - Nothing here ever names a local daemon endpoint, so there is no fallback.
// - A reconnect that reaches a different profile runtime fails closed.

/** An explicit remote host and profile. The remote daemon owns paths and credentials. */
export interface RemoteTarget {
  /** Stable local label for the host; scopes connection state. */
  hostId: string
  /** The remote profile's ID; scopes connection state together with hostId. */
  profileId: string
  /** OpenSSH destination, such as `user@host` or a Host alias from ssh_config. */
  destination: string
  /** Absolute path of the remote profile daemon's command socket. */
  remoteSocket: string
  /**
   * The host key pinned in the daemon's registry, `type base64`
   * (`remote.host.list` host_public_key). When set, ssh trusts only this key,
   * exactly as the daemon's own connections do. Null trusts the user's
   * known_hosts; only an explicitly typed destination uses that.
   */
  hostPublicKey: string | null
}

export type RemotePhase =
  | 'idle'
  | 'forwarding'
  | 'handshaking'
  | 'connected'
  | 'unknown'
  | 'failed'
  | 'stopped'

/** Why a connection stopped retrying. Each needs a person to act. */
export type RemoteFailure = 'host_untrusted' | 'auth_failed' | 'incompatible' | 'identity_mismatch' | 'invalid_target'

/** The identity a remote daemon proves in its hello. */
export interface RemoteIdentity {
  /** The runtime socket path inside the remote profile directory; pins the profile. */
  runtimeSocket: string
  bootId: string
  buildId: string | null
}

export interface RemoteState {
  key: string
  phase: RemotePhase
  /** Pinned on the first successful handshake; every reconnect must match it. */
  pinned: RemoteIdentity | null
  /** The identity of the current connection, while connected. */
  current: RemoteIdentity | null
  /** Consecutive failed attempts since the last successful handshake. */
  attempt: number
  failure: RemoteFailure | null
  detail: string
}

export type RemoteEvent =
  | { type: 'start' }
  | { type: 'forward_ready' }
  | { type: 'forward_failed'; exitCode: number | null; stderr: string }
  | { type: 'hello'; hello: Record<string, unknown> }
  | { type: 'hello_failed'; incompatible: boolean; detail: string }
  | { type: 'link_lost'; detail: string }
  | { type: 'retry_due' }
  | { type: 'stop' }

export type RemoteEffect =
  | { type: 'spawn_forward' }
  | { type: 'kill_forward' }
  | { type: 'send_hello' }
  | { type: 'schedule_retry'; delayMs: number }
  | { type: 'cancel_retry' }

export interface RemoteStep {
  state: RemoteState
  effects: RemoteEffect[]
}

const APPLICATION_PROTOCOL = 'ade-application-v1'
const SESSION_PROTOCOL = 'ade-sessions-v1'
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 30_000
/** macOS sun_path holds 104 bytes including the terminator. */
const MAX_UNIX_SOCKET_BYTES = 103
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Destination: optional user@, then a host name, alias, IPv4 or bracketless IPv6.
// A leading '-' would be parsed by ssh as an option, so it is rejected.
const DESTINATION_PATTERN = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9._:%-]{0,252}$/

const HOST_KEY_ALGORITHMS: Readonly<Record<string, string>> = {
  'ssh-ed25519': 'ssh-ed25519',
  'ecdsa-sha2-nistp256': 'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384': 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521': 'ecdsa-sha2-nistp521',
  // An RSA key is verified with SHA-2 signatures only, as in the daemon.
  'ssh-rsa': 'rsa-sha2-512,rsa-sha2-256',
}

/** A parsed pinned host key. */
interface PinnedHostKey {
  keyType: string
  base64: string
  /** The `HostKeyAlgorithms` value that makes ssh ask for this key type. */
  algorithms: string
}

/** Parses `type base64 [comment]`; the blob must name the same type. Returns null when unusable. */
function parseHostPublicKey(line: string): PinnedHostKey | null {
  const [keyType, base64] = line.trim().split(/\s+/)
  if (!keyType || !base64) return null
  const algorithms = HOST_KEY_ALGORITHMS[keyType]
  if (!Object.hasOwn(HOST_KEY_ALGORITHMS, keyType) || algorithms === undefined) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null
  const blob = Buffer.from(base64, 'base64')
  if (blob.length < 4) return null
  const length = blob.readUInt32BE(0)
  if (blob.subarray(4, 4 + length).toString('latin1') !== keyType) return null
  return { keyType, base64, algorithms }
}

/** The known_hosts alias that ties a registry host to its pinned key (daemon: host_key_alias). */
function hostKeyAlias(hostId: string): string {
  return `ade-remote-${hostId}`
}

function pinnedKey(target: RemoteTarget): PinnedHostKey | null {
  if (target.hostPublicKey === null) return null
  const key = parseHostPublicKey(target.hostPublicKey)
  if (!key) throw new TypeError('The pinned host key is not a supported SSH public key.')
  return key
}

/** The one-line private known_hosts file for a pinned target, or null when the target pins no key. */
export function pinnedKnownHosts(target: RemoteTarget): string | null {
  const key = pinnedKey(target)
  return key ? `${hostKeyAlias(target.hostId)} ${key.keyType} ${key.base64}\n` : null
}

/**
 * ssh options that decide which host key is trusted. A pinned target trusts
 * only its key, through a private known_hosts file that must hold
 * {@link pinnedKnownHosts}; the user's and system files, DNS and key updates
 * are all ignored, as in the daemon's `ssh_args`.
 */
export function hostTrustArgs(target: RemoteTarget, knownHostsFile: string | null): string[] {
  const common = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes']
  const key = pinnedKey(target)
  if (!key) return common
  if (knownHostsFile === null || !knownHostsFile.startsWith('/') || /[\s\0]/.test(knownHostsFile)) {
    throw new TypeError('A pinned host needs an absolute known_hosts path without whitespace.')
  }
  return [
    ...common,
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'KnownHostsCommand=none',
    '-o', `HostKeyAlias=${hostKeyAlias(target.hostId)}`,
    '-o', `HostKeyAlgorithms=${key.algorithms}`,
    '-o', 'UpdateHostKeys=no',
    '-o', 'CheckHostIP=no',
    '-o', 'VerifyHostKeyDNS=no',
  ]
}

/** Returns a reason when the target cannot be used, or null. */
export function validateTarget(target: RemoteTarget): string | null {
  if (!ID_PATTERN.test(target.hostId)) return 'Host ID must be 1-128 letters, digits, ".", "_", ":" or "-".'
  if (!ID_PATTERN.test(target.profileId)) return 'Profile ID must be 1-128 letters, digits, ".", "_", ":" or "-".'
  if (!DESTINATION_PATTERN.test(target.destination)) return 'SSH destination must be [user@]host with no options.'
  const socket = target.remoteSocket
  if (!socket.startsWith('/') || socket.includes('\0') || socket.includes(':') || /\s/.test(socket) ||
    socket.split('/').includes('..')) {
    return 'Remote socket must be an absolute path without "..", ":" or whitespace.'
  }
  if (Buffer.byteLength(socket) > MAX_UNIX_SOCKET_BYTES) return 'Remote socket path is too long for a Unix socket.'
  if (target.hostPublicKey !== null && !parseHostPublicKey(target.hostPublicKey)) {
    return 'The pinned host key is not a supported SSH public key.'
  }
  return null
}

/** The key that scopes all connection state to one host and profile. */
export function connectionKey(target: Pick<RemoteTarget, 'hostId' | 'profileId'>): string {
  return `${target.hostId}\u0000${target.profileId}`
}

/** Returns a reason when the forwarded local socket path is unusable, or null. */
export function validateLocalSocket(path: string): string | null {
  if (!path.startsWith('/') || path.includes(':') || /\s/.test(path)) {
    return 'Local forward socket must be an absolute path without ":" or whitespace.'
  }
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_BYTES) return 'Local forward socket path is too long for a Unix socket.'
  return null
}

/**
 * OpenSSH arguments for `ssh -L local_socket:remote_socket`. The host key is
 * checked strictly (see {@link hostTrustArgs}) and BatchMode refuses
 * interactive prompts, so an unknown or changed host fails closed. The
 * destination follows `--`, so it can never be read as an option.
 */
export function sshForwardArgs(target: RemoteTarget, localSocket: string, knownHostsFile: string | null): string[] {
  return [
    '-N', '-T',
    ...hostTrustArgs(target, knownHostsFile),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StreamLocalBindUnlink=yes',
    '-o', 'StreamLocalBindMask=0177',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-L', `${localSocket}:${target.remoteSocket}`,
    '--', target.destination,
  ]
}

/** Classifies an ssh exit. Trust and authentication failures do not retry on their own. */
export function classifySshExit(stderr: string): 'host_untrusted' | 'auth_failed' | 'transient' {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No [A-Z0-9-]+ host key is known/i
    .test(stderr)) return 'host_untrusted'
  if (/Permission denied \(/i.test(stderr)) return 'auth_failed'
  return 'transient'
}

/** Parses the identity a hello proves, or returns a reason it is unusable. */
function helloIdentity(hello: Record<string, unknown>): RemoteIdentity | { incompatible: string } {
  if (hello.type !== 'hello') return { incompatible: 'Remote daemon did not answer hello.' }
  if (hello.application_protocol !== APPLICATION_PROTOCOL || hello.session_protocol !== SESSION_PROTOCOL) {
    return { incompatible: 'Remote daemon uses an incompatible application or session protocol.' }
  }
  const runtimeSocket = hello.runtime_socket
  const bootId = hello.boot_id
  const buildId = hello.build_id
  if (typeof runtimeSocket !== 'string' || runtimeSocket.length === 0 ||
    typeof bootId !== 'string' || bootId.length === 0 ||
    !(buildId === null || buildId === undefined || typeof buildId === 'string')) {
    return { incompatible: 'Remote daemon hello is missing its runtime identity.' }
  }
  return { runtimeSocket, bootId, buildId: buildId ?? null }
}

/** Exponential backoff for reconnect attempt n (1-based), capped at 30 s. */
export function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 6))
}

export function initialRemoteState(target: RemoteTarget): RemoteState {
  const invalid = validateTarget(target)
  return {
    key: connectionKey(target),
    phase: invalid ? 'failed' : 'idle',
    pinned: null,
    current: null,
    attempt: 0,
    failure: invalid ? 'invalid_target' : null,
    detail: invalid ?? 'Not connected.',
  }
}

function lose(state: RemoteState, detail: string): RemoteStep {
  const attempt = state.attempt + 1
  return {
    state: { ...state, phase: 'unknown', current: null, attempt, failure: null,
      detail: `${detail} Remote state is unknown; reconnecting to the same host.` },
    effects: [{ type: 'kill_forward' }, { type: 'schedule_retry', delayMs: retryDelay(attempt) }],
  }
}

function fail(state: RemoteState, failure: RemoteFailure, detail: string): RemoteStep {
  return {
    state: { ...state, phase: 'failed', current: null, failure, detail },
    effects: [{ type: 'kill_forward' }, { type: 'cancel_retry' }],
  }
}

const failureDetail: Record<Exclude<RemoteFailure, 'invalid_target' | 'incompatible' | 'identity_mismatch'>, string> = {
  host_untrusted: 'SSH could not verify the remote host key. Verify and trust the host with ssh first.',
  auth_failed: 'SSH authentication failed. Load a key into the agent or fix ssh_config, then reconnect.',
}

/** The reconnect and host-pinning state machine. Pure: effects are returned, not run. */
export function reduceRemote(state: RemoteState, event: RemoteEvent): RemoteStep {
  const none: RemoteStep = { state, effects: [] }
  if (event.type === 'stop') {
    if (state.phase === 'stopped') return none
    return { state: { ...state, phase: 'stopped', current: null, detail: 'Disconnected by request.' },
      effects: [{ type: 'kill_forward' }, { type: 'cancel_retry' }] }
  }
  if (event.type === 'start') {
    if (state.failure === 'invalid_target') return none
    if (state.phase !== 'idle' && state.phase !== 'stopped' && state.phase !== 'failed') return none
    // An explicit start clears a failure, but the identity pin survives: the
    // same target must still reach the same profile runtime.
    return { state: { ...state, phase: 'forwarding', failure: null, attempt: 0,
      detail: 'Opening SSH forward…' }, effects: [{ type: 'spawn_forward' }] }
  }
  switch (state.phase) {
    case 'forwarding':
      if (event.type === 'forward_ready') {
        return { state: { ...state, phase: 'handshaking', detail: 'Handshaking with remote daemon…' },
          effects: [{ type: 'send_hello' }] }
      }
      if (event.type === 'forward_failed' || event.type === 'link_lost') {
        if (event.type === 'forward_failed') {
          const kind = classifySshExit(event.stderr)
          if (kind !== 'transient') return fail(state, kind, failureDetail[kind])
          return lose(state, `SSH forward exited${event.exitCode === null ? '' : ` with code ${event.exitCode}`}.`)
        }
        return lose(state, event.detail)
      }
      return none
    case 'handshaking':
      if (event.type === 'hello') {
        const identity = helloIdentity(event.hello)
        if ('incompatible' in identity) return fail(state, 'incompatible', identity.incompatible)
        if (state.pinned && state.pinned.runtimeSocket !== identity.runtimeSocket) {
          return fail(state, 'identity_mismatch',
            'The remote socket now reaches a different profile runtime. Refusing to continue on the wrong profile.')
        }
        return { state: { ...state, phase: 'connected', pinned: state.pinned ?? identity, current: identity,
          attempt: 0, failure: null, detail: '' }, effects: [] }
      }
      if (event.type === 'hello_failed') {
        return event.incompatible ? fail(state, 'incompatible', event.detail) : lose(state, event.detail)
      }
      if (event.type === 'forward_failed') {
        const kind = classifySshExit(event.stderr)
        return kind === 'transient' ? lose(state, 'SSH forward exited during handshake.') : fail(state, kind, failureDetail[kind])
      }
      if (event.type === 'link_lost') return lose(state, event.detail)
      return none
    case 'connected':
      if (event.type === 'forward_failed') return lose(state, 'SSH forward exited.')
      if (event.type === 'link_lost') return lose(state, event.detail)
      return none
    case 'unknown':
      if (event.type === 'retry_due') {
        return { state: { ...state, phase: 'forwarding', detail: `${state.detail} Attempt ${state.attempt + 1}.` },
          effects: [{ type: 'spawn_forward' }] }
      }
      return none
    default:
      return none
  }
}

export type RemoteAdmission = { admitted: true } | { admitted: false; reason: string }

/**
 * Whether a request may be sent now. Only a connected, pinned target admits
 * requests; every other phase refuses before sending, so no effect is replayed
 * and nothing is redirected elsewhere.
 */
export function admitRemoteRequest(state: RemoteState, target: RemoteTarget): RemoteAdmission {
  if (state.key !== connectionKey(target)) return { admitted: false, reason: 'Request targets a different host or profile.' }
  if (state.phase !== 'connected' || !state.current) {
    return { admitted: false, reason: state.phase === 'unknown'
      ? 'Remote host is disconnected; its state is unknown. The request was not sent.'
      : `Remote host is not connected (${state.phase}). The request was not sent.` }
  }
  return { admitted: true }
}

/** The status a client shows for a host. Link loss is `unknown`, never a local status. */
export function remoteStatus(state: RemoteState): 'connected' | 'connecting' | 'unknown' | 'failed' | 'disconnected' {
  switch (state.phase) {
    case 'connected': return 'connected'
    case 'forwarding':
    case 'handshaking': return state.pinned ? 'unknown' : 'connecting'
    case 'unknown': return 'unknown'
    case 'failed': return 'failed'
    default: return 'disconnected'
  }
}
