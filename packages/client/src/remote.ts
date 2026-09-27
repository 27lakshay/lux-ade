// Remote daemon transport over an SSH-forwarded Unix socket
// (`ssh -L local_socket:remote_socket`). Requests use the same version-checked
// hello and command semantics as a local profile socket. The decisions live in
// remote-state.ts; this file only runs their effects.
// Pattern studied, not copied: Orca src/main/ssh/system-ssh-forward-process.ts (MIT).
import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeRequest, decodeResponse, type ExecutionHostEntry, type Operation, type PlacementDecision, type Request,
  type Response,
} from '@ade/contracts'
import { DaemonRequestError, requestDaemon, type DaemonResponse, type RequestOptions } from './request.js'
import {
  admitRemoteRequest, connectionKey, initialRemoteState, pinnedKnownHosts, reduceRemote, sshForwardArgs,
  validateLocalSocket,
  type RemoteEffect, type RemoteEvent, type RemoteState, type RemoteTarget,
} from './remote-state.js'
import {
  admitPlacement, previewCapability, type PlacementAdmission, type PreviewCapability,
} from './placement.js'

export {
  admitPlacement, deviceCapability, previewCapability, sshPreviewForwardArgs,
  type DeviceCapability, type PlacementAdmission, type PreviewCapability,
} from './placement.js'
export {
  connectionKey, remoteStatus, validateTarget,
  type RemoteFailure, type RemoteIdentity, type RemotePhase, type RemoteState, type RemoteTarget,
} from './remote-state.js'

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

  /** Stops the forward for good and removes the private socket directory. */
  dispose(): void {
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
          finish(new DaemonRequestError(state.failure === 'incompatible' ? 'incompatible' : 'unavailable',
            state.detail), state)
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
      return await requestDaemon(this.localSocket, op, fields, options)
    } catch (error) {
      if (error instanceof DaemonRequestError && error.code === 'unavailable' && error.delivery !== 'rejected') {
        this.dispatch({ type: 'link_lost', detail: 'The forwarded remote socket closed.' })
      }
      throw error
    }
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

  /** A typed command with the same contract checks as a local `dailyUseCommand`. */
  async command<O extends Operation>(request: Request<O>, options: RequestOptions = {}): Promise<Response<O>> {
    decodeRequest(request)
    const { op, ...fields } = request
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
    requestDaemon(this.localSocket, 'hello', {}, { timeoutMs: this.options.helloTimeoutMs ?? 10_000 }).then(
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
        const incompatible = error instanceof DaemonRequestError && error.code === 'incompatible'
        this.dispatch({ type: 'hello_failed', incompatible,
          detail: error instanceof Error ? error.message : String(error) })
      },
    )
  }
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
        existing.target.hostPublicKey !== target.hostPublicKey) {
        throw new DaemonRequestError('conflict',
          'This host and profile is already bound to a different SSH destination, remote socket or host key.')
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
