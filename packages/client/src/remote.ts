// Remote daemon transport over an SSH-forwarded Unix socket
// (`ssh -L local_socket:remote_socket`). Requests use the same version-checked
// hello and command semantics as a local profile socket. The decisions live in
// remote-state.ts; this file only runs their effects.
// Pattern studied, not copied: Orca src/main/ssh/system-ssh-forward-process.ts (MIT).
import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeResponse, type ExecutionHost, type ExecutionHostEntry, type Operation, type PlacementDecision,
  type Response,
} from '@ade/contracts'
import { encodeCall, type CallRequest } from './call.js'
import { AdeClient } from './index.js'
import { DaemonRequestError, requestDaemon, type DaemonResponse, type RequestOptions } from './request.js'
import {
  admitRemoteRequest, connectionKey, pairingRefusal, requestLostLink, initialRemoteState, pinnedKnownHosts,
  reduceRemote, sshForwardArgs, validateLocalSocket,
  type RemoteEffect, type RemoteEvent, type RemoteState, type RemoteTarget,
} from './remote-state.js'
import {
  admitPlacement, previewCapability, sshPreviewForwardArgs, type PlacementAdmission, type PreviewCapability,
} from './placement.js'

export {
  admitPlacement, deviceCapability, previewCapability, sshPreviewForwardArgs,
  type DeviceCapability, type PlacementAdmission, type PreviewCapability,
} from './placement.js'
export {
  connectionKey, remoteStatus, validateTarget,
  type RemoteFailure, type RemoteIdentity, type RemotePairingCredential, type RemotePhase, type RemoteState,
  type RemoteTarget,
} from './remote-state.js'

/**
 * A remote service forwarded to this machine over SSH: `localUrl` reaches the
 * service at `remoteHost:remotePort` on `host` and nowhere else. When the
 * forward ends it stays closed; it is never reopened against another host.
 */
export interface RemotePreview {
  readonly host: ExecutionHost
  /** The service URL as the remote host sees it. */
  readonly url: string
  /** The same URL through the forward, on this machine's loopback address. */
  readonly localUrl: string
  readonly localPort: number
  readonly remoteHost: string
  readonly remotePort: number
  /** Resolves with the reason once the forward has ended. */
  readonly closed: Promise<string>
  isOpen(): boolean
  close(): void
}

export interface RemoteTransportOptions {
  /** The ssh executable. Defaults to `ssh` on PATH. */
  sshPath?: string
  /** How long the forward may take to bind its local socket. */
  forwardTimeoutMs?: number
  /** Deadline for the hello handshake over the forward. */
  helloTimeoutMs?: number
}

const FORWARD_PROBE_MS = 50
const STDERR_LIMIT = 8 * 1024
const KILL_GRACE_MS = 2_000

type Listener = (state: RemoteState) => void

/** One host and profile's connection. It never reaches any other daemon. */
export class RemoteDaemonTransport {
  private state: RemoteState
  private readonly listeners = new Set<Listener>()
  private readonly directory: string
  private readonly localSocket: string
  /** The private known_hosts file holding only the pinned key, or null when the target pins none. */
  private readonly knownHostsFile: string | null = null
  private child: ChildProcess | null = null
  private childGeneration = 0
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly previews = new Set<RemotePreview>()
  private readonly feeds = new Set<AdeClient>()

  constructor(readonly target: RemoteTarget, private readonly options: RemoteTransportOptions = {}) {
    this.target = Object.freeze({ ...target })
    this.state = initialRemoteState(this.target)
    // mkdtemp creates the directory with mode 0700, so only this user can reach the forward.
    this.directory = mkdtempSync(join(tmpdir(), 'ade-remote-'))
    this.localSocket = join(this.directory, 'daemon.sock')
    const invalid = validateLocalSocket(this.localSocket)
    if (invalid) {
      rmSync(this.directory, { recursive: true, force: true })
      throw new DaemonRequestError('invalid_request', invalid)
    }
    // An invalid pinned key already failed the target; the forward is never spawned then.
    const knownHosts = this.state.failure === 'invalid_target' ? null : pinnedKnownHosts(this.target)
    if (knownHosts !== null) {
      this.knownHostsFile = join(this.directory, 'known_hosts')
      writeFileSync(this.knownHostsFile, knownHosts, { mode: 0o600 })
    }
  }

  getState(): RemoteState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    this.dispatch({ type: 'start' })
  }

  /** Stops the forward. start() may reconnect to the same pinned target later. */
  stop(): void {
    this.dispatch({ type: 'stop' })
  }

  /** Stops the forward, its feeds and previews for good and removes the private socket directory. */
  dispose(): void {
    for (const feed of this.feeds) feed.stop()
    this.feeds.clear()
    for (const preview of this.previews) preview.close()
    this.stop()
    rmSync(this.directory, { recursive: true, force: true })
  }

  /** Resolves once connected; rejects when the connection fails, stops or times out. */
  waitUntilConnected(timeoutMs: number): Promise<RemoteState> {
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | null = null
      let done = false
      const finish = (error: DaemonRequestError | null, state: RemoteState): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        queueMicrotask(() => unsubscribe?.())
        if (error) reject(error)
        else resolve(state)
      }
      const timer = setTimeout(() => finish(new DaemonRequestError('timeout',
        `Remote host did not connect in time: ${this.state.detail}`), this.state), timeoutMs)
      unsubscribe = this.subscribe((state) => {
        if (state.phase === 'connected') finish(null, state)
        else if (state.phase === 'failed') {
          const code = state.failure === 'incompatible' ? 'incompatible'
            : state.failure === 'pairing_revoked' ? 'pairing_revoked'
              : state.failure === 'unauthorized' ? 'unauthenticated' : 'unavailable'
          finish(new DaemonRequestError(code, state.detail), state)
        } else if (state.phase === 'stopped') finish(new DaemonRequestError('unavailable', state.detail), state)
      })
    })
  }

  /**
   * One request to the pinned remote daemon. It is refused unsent unless the
   * connection is up. A lost reply keeps its `unknown` delivery; this transport
   * never retries it, so the caller reconciles with its own operation ID.
   */
  async request(op: string, fields: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<DaemonResponse> {
    const admission = admitRemoteRequest(this.state, this.target)
    if (!admission.admitted) throw new DaemonRequestError('unavailable', admission.reason, 'not_sent')
    try {
      return await requestDaemon(this.localSocket, op, fields, { ...options, pairing: this.target.pairing ?? null })
    } catch (error) {
      if (error instanceof DaemonRequestError) {
        const refused = pairingRefusal(error)
        if (refused) this.dispatch({ type: 'refused', failure: refused, detail: error.message })
        else if (requestLostLink(error)) this.dispatch({ type: 'link_lost', detail: 'The forwarded remote socket closed.' })
      }
      throw error
    }
  }

  /**
   * The remote daemon's feed (`session.subscribe`) over this transport's
   * forward, presenting this target's pairing. Frames carry the remote
   * daemon's own boot ID and revision, so they cannot be confused with
   * another host's. The feed reconnects only through this same forward, and
   * stops for good when the host refuses the pairing. Call start() on it.
   */
  openFeed(): AdeClient {
    const feed = new AdeClient(this.localSocket, { pairing: this.target.pairing ?? null })
    this.feeds.add(feed)
    return feed
  }

  /**
   * Forwards a service URL on this transport's host to this machine with
   * `ssh -L 127.0.0.1:PORT:remoteHost:remotePort`, pinned to the same host
   * key. It is refused, with nothing started, unless {@link previewCapability}
   * reports it available now: the entry is this host's, the URL is that
   * host's own loopback address, and the transport is connected.
   */
  async openPreview(entry: ExecutionHostEntry, url: string, options: { timeoutMs?: number } = {}): Promise<RemotePreview> {
    const capability = this.previewCapability(entry, url)
    if (!capability.available || capability.remoteHost === null || capability.remotePort === null) {
      throw new DaemonRequestError('unavailable', `${capability.reason ?? 'This preview cannot be forwarded.'} ` +
        'Nothing was forwarded.', 'not_sent')
    }
    const localPort = await freeLoopbackPort()
    const args = sshPreviewForwardArgs(this.target, capability, localPort, this.knownHostsFile)
    const child = spawn(this.options.sshPath ?? 'ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8').slice(0, STDERR_LIMIT - stderr.length)
    })
    let open = true
    let settle: (reason: string) => void = () => {}
    const closed = new Promise<string>((resolve) => { settle = resolve })
    const end = (reason: string): void => {
      if (!open) return
      open = false
      this.previews.delete(preview)
      settle(reason)
    }
    child.once('error', (error) => end(`The preview forward could not run: ${error.message}`))
    child.once('exit', (code) => end(code === 0 || code === null ? 'The preview forward was closed.'
      : `The preview forward to ${this.target.hostId} ended: ${stderr.trim() || `exit ${code}`}`))
    const local = new URL(url)
    local.hostname = '127.0.0.1'
    local.port = String(localPort)
    const preview: RemotePreview = {
      host: capability.host, url, localUrl: local.toString(), localPort,
      remoteHost: capability.remoteHost, remotePort: capability.remotePort, closed,
      isOpen: () => open,
      close: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        end('The preview forward was closed.')
      },
    }
    this.previews.add(preview)
    const deadline = Date.now() + (options.timeoutMs ?? this.options.forwardTimeoutMs ?? 20_000)
    while (open && !(await acceptsConnections(localPort))) {
      if (Date.now() >= deadline) {
        preview.close()
        throw new DaemonRequestError('timeout', `The preview forward to ${this.target.hostId} did not open in time.`,
          'not_sent')
      }
      await new Promise((resolve) => setTimeout(resolve, FORWARD_PROBE_MS))
    }
    if (!open) throw new DaemonRequestError('unavailable', `${await closed} Nothing is forwarded.`, 'not_sent')
    return preview
  }

  /**
   * Final admission for new work the daemon's `placement.check` admitted on
   * this transport's host: it must be connected now. Never another host.
   */
  admitPlacement(decision: PlacementDecision): PlacementAdmission {
    return admitPlacement(decision, this.state, this.target)
  }

  /** Whether a service URL on this host can be forwarded over this transport now. */
  previewCapability(entry: ExecutionHostEntry, url: string): PreviewCapability {
    return previewCapability(entry, url, this.state, this.target)
  }

  /**
   * A typed command with the same contract checks as a local `dailyUseCommand`;
   * an effect command without an `operation_id` is sent under a fresh one.
   */
  async command<O extends Operation>(request: { op: O } & CallRequest<O>, options: RequestOptions = {}): Promise<Response<O>> {
    const { op: requested, ...body } = request as unknown as { op: O } & Record<string, unknown>
    const { fields } = encodeCall(requested, body)
    const op = requested
    const response = await this.request(op, fields, options)
    try { return decodeResponse(op, response) as Response<O> }
    catch (error) {
      throw new DaemonRequestError('protocol', `Remote ${op} reply failed its contract: ${String(error)}`, 'unknown')
    }
  }

  private dispatch(event: RemoteEvent): void {
    const step = reduceRemote(this.state, event)
    if (step.state !== this.state) {
      this.state = step.state
      for (const listener of this.listeners) listener(this.state)
    }
    for (const effect of step.effects) this.run(effect)
  }

  private run(effect: RemoteEffect): void {
    switch (effect.type) {
      case 'spawn_forward': return this.spawnForward()
      case 'kill_forward': return this.killForward()
      case 'send_hello': return this.sendHello()
      case 'schedule_retry':
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.dispatch({ type: 'retry_due' })
        }, effect.delayMs)
        return
      case 'cancel_retry':
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = null
        return
    }
  }

  private spawnForward(): void {
    this.killForward()
    const generation = ++this.childGeneration
    rmSync(this.localSocket, { force: true })
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(this.options.sshPath ?? 'ssh', sshForwardArgs(this.target, this.localSocket, this.knownHostsFile),
        { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      queueMicrotask(() => this.dispatch({ type: 'forward_failed', exitCode: null, stderr: String(error) }))
      return
    }
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8').slice(0, STDERR_LIMIT - stderr.length)
    })
    const exited = (exitCode: number | null, extra = ''): void => {
      if (generation !== this.childGeneration) return
      this.child = null
      this.clearProbe()
      this.dispatch({ type: 'forward_failed', exitCode, stderr: `${stderr}${extra}` })
    }
    child.once('error', (error) => exited(null, `\n${error.message}`))
    child.once('exit', (code) => exited(code))
    const deadline = Date.now() + (this.options.forwardTimeoutMs ?? 20_000)
    const probe = (): void => {
      this.probeTimer = null
      if (generation !== this.childGeneration) return
      let bound = false
      try { bound = lstatSync(this.localSocket).isSocket() } catch { bound = false }
      if (bound) return this.dispatch({ type: 'forward_ready' })
      if (Date.now() >= deadline) {
        return this.dispatch({ type: 'link_lost', detail: 'The SSH forward did not open in time.' })
      }
      this.probeTimer = setTimeout(probe, FORWARD_PROBE_MS)
    }
    this.probeTimer = setTimeout(probe, FORWARD_PROBE_MS)
  }

  private clearProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
  }

  private killForward(): void {
    this.clearProbe()
    this.childGeneration++
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      escalate.unref()
      child.once('exit', () => clearTimeout(escalate))
    }
    rmSync(this.localSocket, { force: true })
  }

  private sendHello(): void {
    const generation = this.childGeneration
    requestDaemon(this.localSocket, 'hello', {}, { timeoutMs: this.options.helloTimeoutMs ?? 10_000,
      pairing: this.target.pairing ?? null }).then(
      (hello) => {
        if (generation !== this.childGeneration) return
        try { decodeResponse('hello', hello) }
        catch (error) {
          return this.dispatch({ type: 'hello_failed', incompatible: true,
            detail: `Remote hello failed its contract: ${String(error)}` })
        }
        this.dispatch({ type: 'hello', hello })
      },
      (error: unknown) => {
        if (generation !== this.childGeneration) return
        const refused = error instanceof DaemonRequestError ? pairingRefusal(error) : null
        if (refused) return this.dispatch({ type: 'refused', failure: refused, detail: (error as Error).message })
        const incompatible = error instanceof DaemonRequestError && error.code === 'incompatible'
        this.dispatch({ type: 'hello_failed', incompatible,
          detail: error instanceof Error ? error.message : String(error) })
      },
    )
  }
}

/** A loopback port nothing listens on now, for the local end of a preview forward. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => typeof address === 'object' && address ? resolve(address.port)
        : reject(new Error('No loopback port was assigned.')))
    })
  })
}

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => resolve(false))
  })
}

/**
 * Connections keyed by host and profile. A key maps to exactly one SSH
 * destination and remote socket, so state never crosses hosts or profiles.
 */
export class RemoteConnections {
  private readonly transports = new Map<string, RemoteDaemonTransport>()

  constructor(private readonly options: RemoteTransportOptions = {}) {}

  get(target: RemoteTarget): RemoteDaemonTransport {
    const key = connectionKey(target)
    const existing = this.transports.get(key)
    if (existing) {
      if (existing.target.destination !== target.destination || existing.target.remoteSocket !== target.remoteSocket ||
        existing.target.hostPublicKey !== target.hostPublicKey ||
        existing.target.pairing?.pairingId !== target.pairing?.pairingId) {
        throw new DaemonRequestError('conflict',
          'This host and profile is already bound to a different SSH destination, remote socket, host key or pairing.')
      }
      return existing
    }
    const transport = new RemoteDaemonTransport(target, this.options)
    this.transports.set(key, transport)
    return transport
  }

  remove(target: Pick<RemoteTarget, 'hostId' | 'profileId'>): void {
    const key = connectionKey(target)
    this.transports.get(key)?.dispose()
    this.transports.delete(key)
  }

  stopAll(): void {
    for (const transport of this.transports.values()) transport.dispose()
    this.transports.clear()
  }
}
