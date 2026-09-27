// A scratch profile: one real ade-daemon and the ade-runtime it launches, on
// paths no other test or user profile shares. Readiness, restarts and
// shutdown are all observed through the protocol; nothing here sleeps for a
// fixed time.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { CallRequest, Operation } from '../../../packages/client/dist/index.js'
import type { Response } from '../../../packages/contracts/dist/index.js'
import { rpc } from '../../fixtures/daemon'
import { binaries, scratchEnvironment } from './environment'
import { isRunning, type ProcessLedger } from './processes'
import { mockCalls, providerEnvironment, releaseMock, type MockCall, type MockProvider } from './providers'

export type Hello = Record<string, unknown> & {
  type: 'hello'
  pid: number
  boot_id: string
  runtime_pid: number
  runtime_instance: string
  runtime_socket: string
}

export type CliResult = {
  /** The process exit code; 0 on success. */
  code: number
  /** stdout parsed as JSON on success, stderr parsed as JSON on failure; null when it is not JSON. */
  json: Record<string, unknown> | null
  stdout: string
  stderr: string
}

export type ProfileOptions = {
  /** Extra daemon environment, applied over the scratch and provider environment. */
  env?: Record<string, string>
}

type ClientModule = typeof import('../../../packages/client/dist/index.js')
let clientModule: Promise<ClientModule> | null = null
// The SDK is an ES module; Playwright compiles specs to CommonJS, so load it dynamically.
function client(): Promise<ClientModule> {
  clientModule ??= import(pathToFileURL(binaries.client).href) as Promise<ClientModule>
  return clientModule
}

/** Thrown inside an `until` attempt to stop waiting at once. */
class FatalWait extends Error {
  constructor(readonly reason: Error) { super(reason.message) }
}

const READY_TIMEOUT_MS = 20_000
const EXIT_TIMEOUT_MS = 10_000

/** Retry `attempt` until it resolves, or throw its last error at the deadline. Polls; never sleeps as a wait. */
async function until<T>(what: string, attempt: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await attempt()
      if (value !== undefined) return value
    } catch (error) {
      if (error instanceof FatalWait) throw error.reason
      lastError = error
    }
    await delay(25)
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`)
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`Daemon ${child.pid} did not exit within ${timeoutMs} ms`)), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
}

async function answers(socket: string): Promise<boolean> {
  return rpc(socket, { op: 'hello' }, 1_000).then(() => true, () => false)
}

export class ScratchProfile {
  /** Unique per profile: data, sockets, HOME and provider mocks all live under it. */
  readonly root: string
  readonly dataDirectory: string
  readonly socket: string
  readonly runtimeSocket: string
  /** The scratch HOME every profile process sees. */
  readonly home: string
  /** The folder registered as the daemon's default workspace (ADE_ROOT). */
  readonly defaultWorkspaceRoot: string
  readonly logsDirectory: string
  readonly env: Record<string, string>
  private daemon: ChildProcess | null = null
  private current: Hello | null = null
  private launches = 0

  private constructor(root: string, private readonly ledger: ProcessLedger, options: ProfileOptions) {
    this.root = root
    this.dataDirectory = join(root, 'data')
    this.socket = join(root, 'd.sock')
    this.runtimeSocket = join(root, 'r.sock')
    this.home = join(root, 'home')
    this.defaultWorkspaceRoot = join(root, 'workspace')
    this.logsDirectory = join(root, 'logs')
    this.env = scratchEnvironment(this.home, {
      ...providerEnvironment(root),
      ADE_DATA_DIR: this.dataDirectory,
      ADE_SOCKET: this.socket,
      ADE_RUNTIME_SOCKET: this.runtimeSocket,
      ADE_ROOT: this.defaultWorkspaceRoot,
      ADE_PROFILES_HOME: join(this.home, 'profiles'),
      ...options.env,
    })
  }

  /**
   * Create the profile's directories and start its daemon; resolves once
   * `hello` reports a runtime. `register` sees the profile before the daemon
   * starts, so a failed start is still stopped and diagnosed by the harness.
   */
  static async start(root: string, ledger: ProcessLedger, options: ProfileOptions = {},
    register: (profile: ScratchProfile) => void = () => undefined): Promise<ScratchProfile> {
    const profile = new ScratchProfile(root, ledger, options)
    register(profile)
    for (const directory of [profile.dataDirectory, profile.home, profile.defaultWorkspaceRoot, profile.logsDirectory]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    }
    await writeFile(join(profile.home, '.gitconfig'), '[user]\n\tname = ADE E2E\n\temail = e2e@example.invalid\n')
    await profile.launchDaemon()
    return profile
  }

  /** The `hello` of the running daemon. Throws while no daemon is running. */
  get hello(): Hello {
    if (!this.current) throw new Error('The scratch profile has no running daemon')
    return this.current
  }

  get daemonRunning(): boolean {
    return this.daemon !== null && this.daemon.exitCode === null && this.daemon.signalCode === null
  }

  // --- Requests -------------------------------------------------------------

  /**
   * One operation through the SDK's `call()`: the request is checked against
   * @ade/contracts before it is sent and the reply is validated before it returns.
   */
  async call<O extends Operation>(op: O, request: CallRequest<O>, options: { timeoutMs?: number } = {}): Promise<Response<O>> {
    const { call } = await client()
    const started = Date.now()
    try {
      const reply = await call(this.socket, op, request, options)
      await this.logOperation({ via: 'sdk', op, request, reply: summarize(reply), ms: Date.now() - started })
      return reply
    } catch (error) {
      await this.logOperation({ via: 'sdk', op, request, error: String(error), ms: Date.now() - started })
      throw error
    }
  }

  /** A raw protocol line with no contract check, for `hello`, `runtime.*` and negative tests. */
  async rpc(request: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const started = Date.now()
    try {
      const reply = await rpc(this.socket, request, timeoutMs)
      await this.logOperation({ via: 'rpc', op: request.op, request, reply: summarize(reply), ms: Date.now() - started })
      return reply
    } catch (error) {
      await this.logOperation({ via: 'rpc', op: request.op, request, error: String(error), ms: Date.now() - started })
      throw error
    }
  }

  /** Run the built `ade` CLI against this profile. Never throws for a non-zero exit. */
  async cli(...args: string[]): Promise<CliResult> {
    return this.cliWith({}, ...args)
  }

  /** `cli` with a per-call timeout or extra environment. */
  async cliWith(options: { timeoutMs?: number; env?: Record<string, string> }, ...args: string[]): Promise<CliResult> {
    const started = Date.now()
    const result = await new Promise<CliResult>((resolveResult) => {
      execFile(process.execPath, [binaries.cli, '--socket', this.socket, ...args], {
        cwd: this.defaultWorkspaceRoot, env: { ...this.env, ...options.env },
        timeout: options.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null
        const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0
        resolveResult({ code, stdout, stderr, json: parseJson(code === 0 ? stdout : stderr) })
      })
    })
    await this.logOperation({ via: 'cli', args, code: result.code, reply: result.json ? summarize(result.json) : null,
      ms: Date.now() - started })
    return result
  }

  // --- Providers ------------------------------------------------------------

  mockCalls(provider: MockProvider): Promise<MockCall[]> {
    return mockCalls(this.root, provider)
  }

  releaseMock(provider: MockProvider, name: string): Promise<void> {
    return releaseMock(this.root, provider, name)
  }

  // --- Faults ---------------------------------------------------------------

  /** SIGKILL the daemon and wait until it has exited and its socket stops answering. The runtime keeps running. */
  async killDaemon(): Promise<void> {
    const child = this.daemon
    if (!child || !this.daemonRunning) throw new Error('The scratch profile has no running daemon to kill')
    await this.ledger.sweep()
    await this.logOperation({ via: 'fixture', event: 'kill daemon', pid: child.pid })
    child.kill('SIGKILL')
    await waitForChildExit(child, EXIT_TIMEOUT_MS)
    await until('the killed daemon socket to stop answering', async () => (await answers(this.socket)) ? undefined : true, 5_000)
    this.current = null
  }

  /** SIGKILL the runtime and wait until it has exited. The daemon keeps running and keeps reporting the dead runtime. */
  async killRuntime(): Promise<void> {
    const runtimePid = this.current?.runtime_pid ?? (await this.runtimeHello())?.pid
    if (typeof runtimePid !== 'number') throw new Error('The scratch profile has no known runtime to kill')
    await this.ledger.sweep()
    await this.logOperation({ via: 'fixture', event: 'kill runtime', pid: runtimePid })
    process.kill(runtimePid, 'SIGKILL')
    await until('the killed runtime to exit', async () => (await isRunning(runtimePid)) ? undefined : true, EXIT_TIMEOUT_MS)
  }

  /**
   * Replace the daemon on the same data directory and return the new `hello`.
   * `graceful` (the default) asks the daemon to hand the runtime over with
   * runtime.prepare_restart; `kill` SIGKILLs it first. A stopped daemon is simply started.
   */
  async restartDaemon(mode: 'graceful' | 'kill' = 'graceful'): Promise<Hello> {
    await this.logOperation({ via: 'fixture', event: `restart daemon (${mode})` })
    if (this.daemonRunning) {
      if (mode === 'kill') await this.killDaemon()
      else await this.shutdownDaemon()
    }
    return this.launchDaemon()
  }

  // --- Lifecycle ------------------------------------------------------------

  /** Stop the daemon and the runtime it owns, and confirm both have exited. */
  async stop(): Promise<void> {
    await this.ledger.sweep()
    const failures: string[] = []
    if (this.daemonRunning) {
      await this.shutdownDaemon().catch(async (error) => {
        failures.push(`graceful daemon stop failed: ${String(error)}`)
        this.daemon?.kill('SIGKILL')
        if (this.daemon) await waitForChildExit(this.daemon, EXIT_TIMEOUT_MS).catch(() => undefined)
      })
    }
    await this.stopRuntime().catch((error) => failures.push(`runtime stop failed: ${String(error)}`))
    if (failures.length) throw new Error(`Scratch profile ${this.root} did not stop cleanly:\n${failures.join('\n')}`)
  }

  /** Paths worth attaching when a test fails. */
  diagnosticFiles(): Array<{ name: string; path: string }> {
    const files = [
      { name: 'operations.jsonl', path: join(this.logsDirectory, 'operations.jsonl') },
      { name: 'daemon.log', path: join(this.dataDirectory, 'daemon.log') },
      { name: 'runtime.log', path: join(this.dataDirectory, 'runtime.log') },
      { name: 'codex-calls.jsonl', path: join(this.root, 'providers/codex/calls.jsonl') },
      { name: 'claude-calls.jsonl', path: join(this.root, 'providers/claude/calls.jsonl') },
    ]
    for (let launch = 1; launch <= this.launches; launch++) {
      files.push({ name: `daemon-${launch}.stderr`, path: join(this.logsDirectory, `daemon-${launch}.stderr`) })
    }
    return files
  }

  private async launchDaemon(): Promise<Hello> {
    if (this.daemonRunning) throw new Error('The scratch profile daemon is already running')
    const launch = ++this.launches
    const stderrPath = join(this.logsDirectory, `daemon-${launch}.stderr`)
    const stderr = openSync(stderrPath, 'a')
    let child: ChildProcess
    try {
      child = spawn(binaries.daemon, [], { cwd: this.defaultWorkspaceRoot, env: this.env,
        stdio: ['ignore', 'ignore', stderr] })
    } finally {
      closeSync(stderr)
    }
    this.daemon = child
    this.current = null
    const spawned = new Promise<never>((_, rejectSpawn) => child.once('error', rejectSpawn))
    spawned.catch(() => undefined)
    if (typeof child.pid === 'number') await this.ledger.own(child.pid, `daemon #${launch}`)
    const hello = await Promise.race([spawned, until(`daemon #${launch} to answer hello at ${this.socket}`, async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const output = await readFile(stderrPath, 'utf8').catch(() => '')
        throw new FatalWait(new Error(`Daemon #${launch} exited (${child.exitCode ?? child.signalCode}) before it was ready; stderr (${stderrPath}):\n${output.slice(-4_096)}`))
      }
      const reply = await rpc(this.socket, { op: 'hello' }, 1_000).catch(() => null)
      return reply?.type === 'hello' && reply.pid === child.pid ? reply as Hello : undefined
    }, READY_TIMEOUT_MS)]).catch(async (error: unknown) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await waitForChildExit(child, EXIT_TIMEOUT_MS).catch(() => undefined)
      throw error
    })
    if (typeof hello.runtime_pid !== 'number' || typeof hello.runtime_instance !== 'string') {
      throw new Error(`Daemon #${launch} did not report a runtime identity`)
    }
    await this.ledger.own(hello.runtime_pid, 'runtime')
    this.current = hello
    await this.logOperation({ via: 'fixture', event: 'daemon ready', launch, pid: hello.pid, boot_id: hello.boot_id,
      runtime_pid: hello.runtime_pid, runtime_instance: hello.runtime_instance })
    return hello
  }

  /**
   * Hand the runtime over and let the daemon exit. When the runtime is already
   * gone (after `killRuntime`) there is nothing to hand over, so the daemon is
   * killed instead.
   */
  private async shutdownDaemon(): Promise<void> {
    try {
      await this.stopDaemonGracefully()
    } catch (error) {
      if (!this.daemonRunning || await this.runtimeHello()) throw error
      await this.logOperation({ via: 'fixture', event: 'graceful stop refused without a runtime', error: String(error) })
      await this.killDaemon()
    }
  }

  private async stopDaemonGracefully(): Promise<void> {
    const child = this.daemon
    if (!child || !this.daemonRunning) return
    const bootId = this.current?.boot_id ?? (await rpc(this.socket, { op: 'hello' }, 1_000)).boot_id
    await until('runtime.prepare_restart to be accepted', async () => {
      try {
        await rpc(this.socket, { op: 'runtime.prepare_restart', boot_id: bootId }, 5_000)
        return true
      } catch (error) {
        // Admission and in-flight Git work are transient; anything else is a real failure.
        if (/retry shortly|retry after completion/.test(String(error))) return undefined
        throw new FatalWait(error as Error)
      }
    }, EXIT_TIMEOUT_MS)
    await waitForChildExit(child, EXIT_TIMEOUT_MS)
    this.current = null
  }

  private async runtimeHello(): Promise<Record<string, unknown> | null> {
    return rpc(this.runtimeSocket, { op: 'hello' }, 1_000).catch(() => null)
  }

  private async stopRuntime(): Promise<void> {
    const runtime = await this.runtimeHello()
    if (!runtime) return
    const expected = await realpath(this.dataDirectory)
    const actual = typeof runtime.data_directory === 'string' ? await realpath(runtime.data_directory).catch(() => '') : ''
    if (actual !== expected) throw new Error(`Refusing to stop a runtime at ${this.runtimeSocket} that serves ${actual}`)
    const pid = runtime.pid
    await until('runtime.stop to be accepted', async () => {
      try {
        await rpc(this.runtimeSocket, { op: 'runtime.stop', instance_id: runtime.instance_id, stop_active: true }, 2_000)
        return true
      } catch (error) {
        if (!(await this.runtimeHello()) && !(typeof pid === 'number' && await isRunning(pid))) return true
        // The runtime refuses while a daemon is still attached; that detaches as the daemon exits.
        if (/Disconnect the application daemon|closed before a reply|timed out/.test(String(error))) return undefined
        throw new FatalWait(error as Error)
      }
    }, EXIT_TIMEOUT_MS)
    await until('the runtime to exit', async () =>
      (await this.runtimeHello()) || (typeof pid === 'number' && await isRunning(pid)) ? undefined : true, EXIT_TIMEOUT_MS)
  }

  private async logOperation(entry: Record<string, unknown>): Promise<void> {
    await appendFile(join(this.logsDirectory, 'operations.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`).catch(() => undefined)
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Keep the operation log readable: the reply type and any operation or request identity it carries. */
function summarize(reply: unknown): Record<string, unknown> {
  if (reply === null || typeof reply !== 'object') return { value: reply }
  const record = reply as Record<string, unknown>
  const summary: Record<string, unknown> = { type: record.type }
  for (const key of ['request_id', 'operation_id', 'receipt', 'code', 'message', 'boot_id', 'revision']) {
    if (key in record) summary[key] = record[key]
  }
  return summary
}
