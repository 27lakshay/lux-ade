// Managed profiles on one scratch host, started the way a user starts them:
// `ade-control profiles create` registers a profile under a scratch
// ADE_PROFILES_HOME, and `ade --profile ID ...` cold-starts its daemon and
// runtime through ade-control on first use. Nothing here launches a daemon
// directly, and no Electron process is involved.
//
// The daemons ade-control starts are detached (setsid), so the harness does not
// see them as children. Import `test` from this file to get the `host`
// fixture: it owns every managed daemon, runtime and their children in the
// harness ledger, and its teardown stops them before the harness checks for
// survivors.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestInfo } from '@playwright/test'
import type { CallRequest, Operation } from '../../../packages/client/dist/index.js'
import type { Response } from '../../../packages/contracts/dist/index.js'
import { rpc } from '../../fixtures/daemon'
import { controlBinary } from './control'
import { binaries, scratchEnvironment, scratchGitConfig } from './environment'
import { test as base, type AdeHarness } from './index'
import { isRunning } from './processes'
import type { CliResult, Hello, ScratchProfile } from './profile'
import { mockCalls, providerEnvironment, releaseMock, type MockCall, type MockProvider } from './providers'

export { expect } from './index'

type ClientModule = typeof import('../../../packages/client/dist/index.js')
let clientModule: Promise<ClientModule> | null = null
function client(): Promise<ClientModule> {
  clientModule ??= import(pathToFileURL(binaries.client).href) as Promise<ClientModule>
  return clientModule
}

/** Poll `probe` until it returns a value, or throw at the deadline. Never sleeps as a wait. */
async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function run(
  binary: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 60_000,
): Promise<CliResult> {
  return new Promise<CliResult>((resolveResult) => {
    execFile(binary, args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: number | string }) | null
      const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0
      resolveResult({ code, stdout, stderr, json: parseJson(code === 0 ? stdout : stderr) })
    })
  })
}

/** One profile registered on the scratch host. Its daemon runs only after something starts it. */
export class ManagedProfile {
  /** Scratch files for this profile's provider mocks, plugin output and operation log. */
  readonly root: string
  readonly logsDirectory: string
  /** The private workspace ade-control gives the profile's daemon (ADE_ROOT). */
  readonly defaultWorkspaceRoot: string
  readonly dataDirectory: string
  /** The environment every CLI run for this profile uses; a cold start hands it to the daemon. */
  readonly env: Record<string, string>
  /** The daemon endpoint ade-control derives from the runtime home. Set by `ProfileHost.create`. */
  socket = ''

  constructor(
    private readonly host: ProfileHost,
    readonly id: string,
    readonly name: string,
    /** `<profiles home>/profiles/<id>/runtime`, as `profile list` reports it. */
    readonly runtimeHome: string,
    index: number,
    env: Record<string, string> = {},
  ) {
    this.root = join(host.ade.root, 'managed', `m${index}`)
    this.logsDirectory = join(this.root, 'logs')
    this.defaultWorkspaceRoot = join(runtimeHome, '..', 'workspace')
    this.dataDirectory = join(runtimeHome, 'data')
    this.env = { ...host.env, ...host.launcher.providers(this.root), ...env }
  }

  /** Run the built `ade` CLI with `--profile ID`. It cold-starts the daemon when none runs. Never throws for a non-zero exit. */
  async cli(...args: string[]): Promise<CliResult> {
    return this.cliWith({}, ...args)
  }

  async cliWith(
    options: { env?: Record<string, string>; profile?: string | null },
    ...args: string[]
  ): Promise<CliResult> {
    const selection = options.profile === null ? [] : ['--profile', options.profile ?? this.id]
    const started = Date.now()
    const result = await run(
      this.host.launcher.cli[0],
      [...this.host.launcher.cli.slice(1), ...selection, ...args],
      { ...this.env, ...options.env },
      this.host.cwd,
    )
    await this.log({
      via: 'cli',
      args: [...selection, ...args],
      code: result.code,
      error: result.code ? result.stderr : undefined,
      ms: Date.now() - started,
    })
    await this.host.track()
    return result
  }

  /** One operation through the SDK's `call()` on the running daemon. It never starts one. */
  async call<O extends Operation>(
    op: O,
    request: CallRequest<O>,
    options: { timeoutMs?: number } = {},
  ): Promise<Response<O>> {
    const { call } = await client()
    const started = Date.now()
    try {
      const reply = await call(this.socket, op, request, options)
      await this.log({ via: 'sdk', op, request, ms: Date.now() - started })
      return reply
    } catch (error) {
      await this.log({ via: 'sdk', op, request, error: String(error), ms: Date.now() - started })
      throw error
    }
  }

  /** One raw protocol line to the running daemon, with no contract check. */
  async rpc(request: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return rpc(this.socket, request, timeoutMs)
  }

  /**
   * The daemon answering at this profile's endpoint, or null when none does.
   * Read through `ade-control runtime status` once the runtime home exists.
   */
  async hello(): Promise<Hello | null> {
    if (
      !(await access(this.runtimeHome).then(
        () => true,
        () => false,
      ))
    )
      return null
    const status = await this.host.control(['runtime', 'status', '--home', this.runtimeHome])
    if (status.code !== 0) throw new Error(`runtime status failed: ${status.stderr}`)
    return (status.json?.daemon as Hello | null | undefined) ?? null
  }

  /** The runtime's own `hello` (pid, instance_id, data_directory), or null when it does not answer. */
  async runtimeHello(socket: string): Promise<Record<string, unknown> | null> {
    return rpc(socket, { op: 'hello' }, 2_000).catch(() => null)
  }

  mockCalls(provider: MockProvider): Promise<MockCall[]> {
    return mockCalls(this.root, provider)
  }

  releaseMock(provider: MockProvider, name: string): Promise<void> {
    return releaseMock(this.root, provider, name)
  }

  /**
   * This profile for fixture helpers that take a `ScratchProfile` but only use
   * `call`, `socket`, `root`, `env`, `logsDirectory` and `defaultWorkspaceRoot`
   * (conversation, terminal, feed, plugin and raw-reply helpers).
   */
  asScratch(): ScratchProfile {
    return this as unknown as ScratchProfile
  }

  /** SIGKILL the daemon; the runtime keeps running. */
  async killDaemon(): Promise<Hello> {
    const hello = await this.hello()
    if (!hello) throw new Error(`Profile ${this.name} has no running daemon to kill`)
    await this.host.track()
    await this.log({ via: 'fixture', event: 'kill daemon', pid: hello.pid })
    process.kill(hello.pid, 'SIGKILL')
    await until('the killed daemon to exit', async () => ((await isRunning(hello.pid)) ? undefined : true))
    await until('the killed daemon endpoint to stop answering', async () => ((await this.hello()) ? undefined : true))
    return hello
  }

  /** SIGKILL a runtime by PID and wait until it has exited. */
  async killRuntime(pid: number): Promise<void> {
    await this.host.track()
    await this.log({ via: 'fixture', event: 'kill runtime', pid })
    process.kill(pid, 'SIGKILL')
    await until('the killed runtime to exit', async () => ((await isRunning(pid)) ? undefined : true))
  }

  /**
   * Stop the profile the way its owner does: hand the runtime over so the
   * daemon exits, then stop the runtime with its active work. A runtime left
   * without a daemon is adopted by a cold start first. Resolves once both have
   * exited; a profile with nothing running is left alone.
   */
  async stop(): Promise<void> {
    await this.host.track()
    let hello = await this.hello()
    if (!hello && this.lastRuntimePid !== null && (await isRunning(this.lastRuntimePid))) {
      const started = await this.host.control(['profiles', 'start', this.id], this.env)
      if (started.code !== 0) throw new Error(`Could not adopt the orphaned runtime: ${started.stderr}`)
      await this.host.track()
      hello = await this.hello()
    }
    if (!hello) return
    await this.log({ via: 'fixture', event: 'stop', pid: hello.pid, runtime_pid: hello.runtime_pid })
    await until('runtime.prepare_restart to be accepted', async () => {
      try {
        await rpc(
          this.socket,
          { op: 'runtime.prepare_restart', operation_id: `restart-${randomUUID()}`, boot_id: hello.boot_id },
          5_000,
        )
        return true
      } catch (error) {
        if (/retry shortly|retry after completion/.test(String(error))) return undefined
        throw error
      }
    })
    await until('the daemon to exit', async () => ((await isRunning(hello.pid)) ? undefined : true))
    const runtime = await this.runtimeHello(hello.runtime_socket)
    if (runtime) {
      await until('runtime.stop to be accepted', async () => {
        try {
          await rpc(
            hello.runtime_socket,
            { op: 'runtime.stop', instance_id: runtime.instance_id, stop_active: true },
            5_000,
          )
          return true
        } catch (error) {
          if (!(await isRunning(runtime.pid as number))) return true
          if (/Disconnect the application daemon|closed before a reply|timed out/.test(String(error))) return undefined
          throw error
        }
      })
      await until('the runtime to exit', async () => ((await isRunning(runtime.pid as number)) ? undefined : true))
    }
  }

  /** The last runtime PID seen for this profile, so a stop can find a runtime its daemon left behind. */
  lastRuntimePid: number | null = null

  async log(entry: Record<string, unknown>): Promise<void> {
    await appendFile(
      join(this.logsDirectory, 'operations.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    ).catch(() => undefined)
  }
}

/**
 * What a host runs: the `ade-control` binary, the `ade` CLI command line, the
 * environment every run starts from, and the provider settings each profile
 * adds. The default is the source build with the deterministic mocks;
 * `fixtures/packaged.ts` supplies the installed `.app` instead.
 */
export type Launcher = {
  control: string
  cli: string[]
  env: (paths: { userHome: string; profilesHome: string }) => Record<string, string>
  providers: (profileRoot: string) => Record<string, string>
}

export const sourceLauncher: Launcher = {
  control: controlBinary,
  cli: [process.execPath, binaries.cli],
  env: ({ userHome, profilesHome }) => scratchEnvironment(userHome, { ADE_PROFILES_HOME: profilesHome }),
  providers: providerEnvironment,
}

/** One scratch host: a profiles home, one user HOME, and the managed profiles registered there. */
export class ProfileHost {
  /** The scratch ADE_PROFILES_HOME. */
  readonly home: string
  /** The one user HOME every profile on this host shares, as on a real machine. */
  readonly userHome: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly profiles: ManagedProfile[] = []

  private constructor(
    readonly ade: AdeHarness,
    readonly launcher: Launcher,
  ) {
    this.home = join(ade.root, 'profiles-home')
    this.userHome = join(ade.root, 'user-home')
    this.cwd = join(ade.root, 'cwd')
    this.env = launcher.env({ userHome: this.userHome, profilesHome: this.home })
  }

  static async create(ade: AdeHarness, launcher: Launcher = sourceLauncher): Promise<ProfileHost> {
    const host = new ProfileHost(ade, launcher)
    for (const directory of [host.userHome, host.cwd]) await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(host.userHome, '.gitconfig'), scratchGitConfig())
    return host
  }

  /** Run `ade-control` on this host. Never throws for a non-zero exit. */
  control(args: string[], env: Record<string, string> = this.env): Promise<CliResult> {
    return run(this.launcher.control, args, env, this.cwd)
  }

  /** The CLI with no profile selection, for `profile list` and selection errors. */
  async cli(...args: string[]): Promise<CliResult> {
    const result = await run(this.launcher.cli[0], [...this.launcher.cli.slice(1), ...args], this.env, this.cwd)
    await this.track()
    return result
  }

  /**
   * Register a new profile with `ade-control profiles create`. Nothing starts.
   * `env` is added to the environment its CLI runs, and so its daemon, get.
   */
  async create(name: string, options: { env?: Record<string, string> } = {}): Promise<ManagedProfile> {
    const created = await this.control(['profiles', 'create', name])
    if (created.code !== 0) throw new Error(`profiles create failed: ${created.stderr}`)
    return this.register((created.json as { profile: { id: string; name: string; home: string } }).profile, options)
  }

  /**
   * Take charge of a profile that is already in the registry, such as one a
   * backend restore published, so its daemon is tracked and stopped like the
   * profiles this host created.
   */
  async register(
    record: { id: string; name: string; home: string },
    options: { env?: Record<string, string> } = {},
  ): Promise<ManagedProfile> {
    const profile = new ManagedProfile(this, record.id, record.name, record.home, this.profiles.length + 1, options.env)
    for (const directory of [profile.root, profile.logsDirectory])
      await mkdir(directory, { recursive: true, mode: 0o700 })
    const located = await this.control(['locate', '--home', record.home])
    if (located.code !== 0) throw new Error(`locate failed: ${located.stderr}`)
    profile.socket = located.json!.socket as string
    this.profiles.push(profile)
    return profile
  }

  /**
   * Own every daemon, runtime and child the managed profiles are running, so
   * the harness holds them to the no-survivor rule.
   */
  async track(): Promise<void> {
    for (const profile of this.profiles) {
      const hello = (await rpc(profile.socket, { op: 'hello' }, 2_000).catch(() => null)) as Hello | null
      if (!hello) continue
      await this.ade.ledger.own(hello.pid, `managed ${profile.name} daemon`)
      if (typeof hello.runtime_pid === 'number') {
        profile.lastRuntimePid = hello.runtime_pid
        await this.ade.ledger.own(hello.runtime_pid, `managed ${profile.name} runtime`)
      }
    }
    await this.ade.ledger.sweep()
  }

  async teardown(testInfo: TestInfo): Promise<void> {
    const failures: string[] = []
    for (const profile of this.profiles) {
      try {
        await profile.stop()
      } catch (error) {
        failures.push(`${profile.name}: ${String(error)}`)
      }
    }
    if (failures.length || testInfo.status !== testInfo.expectedStatus) {
      for (const [index, profile] of this.profiles.entries()) {
        for (const [name, path] of [
          ['operations.jsonl', join(profile.logsDirectory, 'operations.jsonl')],
          ['daemon.log', join(profile.runtimeHome, 'daemon.log')],
          ['data-daemon.log', join(profile.dataDirectory, 'daemon.log')],
          ['runtime.log', join(profile.dataDirectory, 'runtime.log')],
        ] as const) {
          const body = await readFile(path).catch(() => null)
          if (body)
            await testInfo.attach(`m${index + 1}-${name}`, {
              body: body.subarray(Math.max(0, body.length - 1024 * 1024)),
              contentType: 'text/plain',
            })
        }
      }
    }
    if (failures.length) throw new Error(`Managed profiles did not stop cleanly:\n${failures.join('\n')}`)
  }
}

export const test = base.extend<{ host: ProfileHost }>({
  host: async ({ ade }, use, testInfo) => {
    const host = await ProfileHost.create(ade)
    await use(host)
    await host.teardown(testInfo)
  },
})
