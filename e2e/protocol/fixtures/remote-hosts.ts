// Scratch remote hosts for remote-execution specs. A RemoteLab puts a fake
// OpenSSH client (fake-ssh.mjs, installed as `ssh` and `ssh-keyscan`) first on
// PATH. Each RemoteHost is a second scratch root that plays one machine: its
// own HOME, its own PATH holding whichever ADE artifacts the test installed,
// and a fixed ed25519 host key the test can pin or change. Remote commands
// run there through `/bin/sh`, so `ade-control profiles start` starts a real
// remote profile daemon and runtime inside that root. Nothing reaches the
// user's HOME, keys, known_hosts or real ssh.
//
// Import `test` from this file to get the `remote` fixture. Its teardown stops
// every remote daemon and runtime before the harness checks for survivors.
import { secretStoreEnvironment } from './secret-store'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CallRequest, Operation } from '../../../packages/client/dist/index.js'
import type { Response } from '../../../packages/contracts/dist/index.js'
import { rpc } from '../../fixtures/daemon'
import { binaries, repositoryRoot, scratchEnvironment, scratchGitConfig } from './environment'
import { ScratchRepo } from './git'
import { test as base, type AdeHarness } from './index'
import { isRunning, processTable } from './processes'
import type { CliResult, ProfileOptions, ScratchProfile } from './profile'
import { mockCalls, providerEnvironment, type MockCall, type MockProvider } from './providers'

export { expect } from './index'

/** The backend executables a remote host can have installed. */
export type Artifact = 'ade-control' | 'ade-daemon' | 'ade-runtime'
export const allArtifacts: readonly Artifact[] = ['ade-control', 'ade-daemon', 'ade-runtime']
const controlBinary = join(repositoryRoot, 'target/debug/ade-control')
const artifactSource: Record<Artifact, string> = {
  'ade-control': controlBinary,
  'ade-daemon': binaries.daemon,
  'ade-runtime': binaries.runtime,
}

/** One fake ssh or ssh-keyscan invocation, as fake-ssh.mjs logged it. */
export type SshCall = {
  at: number
  pid: number
  program: 'ssh' | 'ssh-keyscan'
  args: string[]
  remote_command?: string
  held?: string
  forwarding?: string[]
  exit?: number | null
  stderr?: string | null
}

/** A generated ed25519 host key: the `type base64` line and its OpenSSH fingerprint. */
export type HostKey = { line: string; fingerprint: string }

export function generateHostKey(): HostKey {
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    return Buffer.concat([length, bytes])
  }
  const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)])
  return {
    line: `ssh-ed25519 ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  }
}

/** One typed operation over a remote transport, checked against @ade/contracts both ways. */
export function remoteCall<O extends Operation>(
  transport: RemoteDaemonTransport,
  op: O,
  request: CallRequest<O>,
): Promise<Response<O>> {
  return transport.command({ op, ...request } as never)
}

let pythonDirectory: string | null | undefined
function interpreterPath(): string {
  if (pythonDirectory === undefined) {
    try {
      pythonDirectory = dirname(
        execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(),
      )
    } catch {
      pythonDirectory = null
    }
  }
  return [dirname(process.execPath), pythonDirectory].filter(Boolean).join(':')
}

type RemoteClientModule = typeof import('../../../packages/client/dist/remote.js')
type RemoteDaemonTransport = InstanceType<RemoteClientModule['RemoteDaemonTransport']>
export type RemoteTarget = ConstructorParameters<RemoteClientModule['RemoteDaemonTransport']>[0]
let remoteModule: Promise<RemoteClientModule> | null = null
/** The SDK's remote transport module (`@ade/client/remote`). */
export function remoteClient(): Promise<RemoteClientModule> {
  remoteModule ??= import(
    pathToFileURL(join(repositoryRoot, 'packages/client/dist/remote.js')).href
  ) as Promise<RemoteClientModule>
  return remoteModule
}

export class RemoteHost {
  /** Where the host's own programs live; first on its PATH. */
  readonly binDirectory: string
  /** The host's HOME. ADE's remote profiles live under it. */
  readonly home: string
  /** The environment every command on this host runs with. */
  readonly env: Record<string, string>
  private key: HostKey
  /** Each remote profile created here, with the ade-control that manages it. */
  private readonly profiles = new Map<string, string>()

  constructor(
    readonly name: string,
    readonly root: string,
    key: HostKey,
  ) {
    this.key = key
    this.binDirectory = join(root, 'bin')
    this.home = join(root, 'home')
    this.env = {
      HOME: this.home,
      USER: process.env.USER ?? 'ade',
      LOGNAME: process.env.USER ?? 'ade',
      SHELL: '/bin/sh',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      PATH: `${this.binDirectory}:${interpreterPath()}:/usr/bin:/bin:/usr/sbin:/sbin`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(this.home, '.gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      // The remote profile's providers are this host's own mocks.
      ...providerEnvironment(root),
      // Never the Keychain in tests (AGENTS.md, machine safety).
      ...secretStoreEnvironment(this.home),
    }
  }

  /** The host key the host presents now. */
  get hostKey(): HostKey {
    return this.key
  }

  /** Present a new host key, as a reinstalled or impersonated machine would. */
  async changeHostKey(): Promise<HostKey> {
    this.key = generateHostKey()
    await writeFile(join(this.root, 'host_key.pub'), `${this.key.line} root@${this.name}\n`)
    return this.key
  }

  /** Install exactly these ADE artifacts in the host's bin directory, removing the others. */
  async install(artifacts: readonly Artifact[]): Promise<void> {
    for (const artifact of allArtifacts) {
      const path = join(this.binDirectory, artifact)
      await rm(path, { force: true })
      // A copy, so ade-control finds its siblings here and not in target/debug.
      if (artifacts.includes(artifact)) await copyFile(artifactSource[artifact], path, fsConstants.COPYFILE_FICLONE)
    }
  }

  /** Cut the link: new ssh connections are refused and open forwards drop. */
  async linkDown(): Promise<void> {
    await writeFile(join(this.root, 'link-down'), '')
  }

  async linkUp(): Promise<void> {
    await rm(join(this.root, 'link-down'), { force: true })
  }

  /** Hold every remote command after it reaches the host, until `releaseCommands`. */
  async holdCommands(): Promise<void> {
    await writeFile(join(this.root, 'hold-commands'), '')
  }

  async releaseCommands(): Promise<void> {
    await rm(join(this.root, 'hold-commands'), { force: true })
  }

  /** Run a program on this host, as its user would at a shell there. Never throws for a non-zero exit. */
  run(program: string, args: string[], timeoutMs = 30_000): Promise<CliResult> {
    return new Promise((resolveResult) => {
      execFile(
        program,
        args,
        { cwd: this.home, env: this.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const failure = error as (Error & { code?: number | string }) | null
          const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0
          let json: Record<string, unknown> | null = null
          try {
            json = JSON.parse(code === 0 ? stdout : (stderr.trim().split('\n').pop() ?? ''))
          } catch {
            json = null
          }
          resolveResult({ code, stdout, stderr, json })
        },
      )
    })
  }

  /** `ade-control` on this host. Needs the artifact installed. */
  control(...args: string[]): Promise<CliResult> {
    return this.run(join(this.binDirectory, 'ade-control'), args)
  }

  /**
   * Create a remote profile with `ade-control profiles create`; the first one
   * is selected. `control` is the host's ade-control to use, the one in its bin
   * directory by default.
   */
  async createProfile(name = 'remote', control = join(this.binDirectory, 'ade-control')): Promise<string> {
    const created = await this.run(control, ['profiles', 'create', name])
    if (created.code !== 0) throw new Error(`ade-control profiles create failed: ${created.stderr}`)
    const id = (created.json?.profile as { id: string }).id
    this.profiles.set(id, control)
    return id
  }

  /** The runtime home ade-control gives a profile on this host. */
  runtimeHome(profileId: string): string {
    return join(this.home, 'Library/Application Support/lux-ade/profiles-v2/profiles', profileId, 'runtime')
  }

  /** The running remote profile daemon's hello, or null when none answers. */
  async daemonHello(profileId: string): Promise<Record<string, unknown> | null> {
    return (await this.daemonStatus(profileId))?.daemon ?? null
  }

  /** The remote profile daemon's socket and, while one answers there, its hello. */
  async daemonStatus(profileId: string): Promise<{ socket: string; daemon: Record<string, unknown> | null } | null> {
    const home = this.runtimeHome(profileId)
    if (
      !(await stat(home).then(
        () => true,
        () => false,
      ))
    )
      return null
    const status = await this.run(controlBinary, ['runtime', 'status', '--home', home])
    if (typeof status.json?.socket !== 'string') return null
    return { socket: status.json.socket, daemon: (status.json.daemon as Record<string, unknown> | null) ?? null }
  }

  /** A Git repository on this host, with one commit on `main`. */
  repo(name: string, initialFiles?: Record<string, string>): Promise<ScratchRepo> {
    return ScratchRepo.create(join(this.root, 'repos', name), this.env, { initialFiles })
  }

  /** What the host's own provider mocks received. The remote profile runs its providers here. */
  mockCalls(provider: MockProvider): Promise<MockCall[]> {
    return mockCalls(this.root, provider)
  }

  /** Every process running an executable installed anywhere on this host. */
  async processes(): Promise<Array<{ pid: number; command: string }>> {
    const prefix = `${this.root}/`
    return (await processTable()).filter((row) => row.command.startsWith(prefix) && !row.state.startsWith('Z'))
  }

  /**
   * Stop every remote profile daemon and runtime on this host: hand the
   * runtime over, let the daemon exit, then stop the runtime. A runtime left
   * without a daemon is adopted by `profiles start` first, then stopped.
   */
  async stop(ade: AdeHarness): Promise<string[]> {
    const failures: string[] = []
    for (const process of await this.processes()) await ade.ledger.own(process.pid, `remote ${this.name}`)
    for (const [profileId, control] of this.profiles) {
      try {
        let status = await this.daemonStatus(profileId)
        if (status && !status.daemon && (await this.processes()).length) {
          await this.run(control, ['profiles', 'start', profileId])
          status = await this.daemonStatus(profileId)
        }
        if (status?.daemon) await stopDaemonAndRuntime(ade, status.socket, status.daemon, `remote ${this.name}`)
      } catch (error) {
        failures.push(`remote host ${this.name} profile ${profileId}: ${String(error)}`)
      }
    }
    return failures
  }
}

async function waitForExit(pid: number, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (await isRunning(pid)) {
    if (Date.now() > deadline) throw new Error(`${what} ${pid} did not exit`)
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
}

async function stopDaemonAndRuntime(
  ade: AdeHarness,
  socket: string,
  hello: Record<string, unknown>,
  role: string,
): Promise<void> {
  const daemonPid = hello.pid as number
  const runtimeSocket = hello.runtime_socket as string
  await ade.ledger.own(daemonPid, `${role} daemon`)
  await ade.ledger.own(hello.runtime_pid as number, `${role} runtime`)
  await ade.ledger.sweep()
  await rpc(
    socket,
    { op: 'runtime.prepare_restart', operation_id: `restart-${randomUUID()}`, boot_id: hello.boot_id },
    5_000,
  )
  await waitForExit(daemonPid, 'remote daemon')
  const runtime = await rpc(runtimeSocket, { op: 'hello' }, 2_000).catch(() => null)
  if (!runtime) return
  await rpc(runtimeSocket, { op: 'runtime.stop', instance_id: runtime.instance_id, stop_active: true }, 5_000)
  await waitForExit(runtime.pid as number, 'remote runtime')
}

/**
 * The variable a lab profile's daemon reads pairing tokens from. `addAndPair`
 * pairs every host with it; `ADE_DEVBOX_TOKEN` holds the same token.
 */
export const pairingTokenEnv = 'ADE_E2E_PAIRING_TOKEN'

export class RemoteLab {
  /** The directory holding the fake `ssh` and `ssh-keyscan`; put it first on PATH. */
  readonly bin: string
  /**
   * The pairing token in a lab profile's environment. A start grants it on the
   * host by its SHA-256; a paired client presents it in hello.
   */
  readonly pairingToken = randomBytes(24).toString('base64url')
  private readonly hosts: RemoteHost[] = []
  private readonly transports: RemoteDaemonTransport[] = []

  private constructor(private readonly ade: AdeHarness) {
    this.bin = join(ade.root, 'ssh-bin')
  }

  static async create(ade: AdeHarness): Promise<RemoteLab> {
    const lab = new RemoteLab(ade)
    await mkdir(lab.bin, { recursive: true, mode: 0o700 })
    const script = await readFile(join(__dirname, 'fake-ssh.mjs'), 'utf8')
    for (const name of ['ssh', 'ssh-keyscan']) {
      await writeFile(join(lab.bin, name), script)
      await chmod(join(lab.bin, name), 0o755)
    }
    // The copies have no extension; this makes Node load them as ES modules.
    await writeFile(join(lab.bin, 'package.json'), '{"type":"module"}\n')
    await lab.saveConfig()
    return lab
  }

  /** The fake ssh executable, for an SDK transport's `sshPath`. */
  get ssh(): string {
    return join(this.bin, 'ssh')
  }

  /**
   * A new remote host reachable as `ssh name`, with `artifacts` installed
   * (all three by default) and a fresh host key.
   */
  async host(name: string, options: { artifacts?: readonly Artifact[] } = {}): Promise<RemoteHost> {
    const host = new RemoteHost(name, join(this.ade.root, 'hosts', name), generateHostKey())
    for (const directory of [host.root, host.binDirectory, host.home])
      await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(host.root, 'host_key.pub'), `${host.hostKey.line} root@${name}\n`)
    await writeFile(join(host.home, '.gitconfig'), scratchGitConfig('ADE Remote E2E', 'remote@example.invalid'))
    await host.install(options.artifacts ?? allArtifacts)
    this.hosts.push(host)
    await this.saveConfig()
    return host
  }

  /** Profile options that put the fake ssh first on the daemon's and CLI's PATH. */
  profileOptions(options: ProfileOptions = {}): ProfileOptions {
    const path = scratchEnvironment(join(this.ade.root, 'unused-home')).PATH
    return {
      ...options,
      env: {
        [pairingTokenEnv]: this.pairingToken,
        ADE_DEVBOX_TOKEN: this.pairingToken,
        ...options.env,
        PATH: `${this.bin}:${path}`,
      },
    }
  }

  /** A local scratch profile whose daemon and CLI reach remote hosts only through the fake ssh. */
  profile(options: ProfileOptions = {}): Promise<ScratchProfile> {
    return this.ade.profile(this.profileOptions(options))
  }

  /** Every ssh and ssh-keyscan invocation so far, oldest first. */
  async calls(): Promise<SshCall[]> {
    const text = await readFile(join(this.bin, 'calls.jsonl'), 'utf8').catch(() => '')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SshCall)
  }

  /**
   * An SDK `RemoteDaemonTransport` that runs the fake ssh. It is disposed at
   * teardown; its forward process is then held to the no-survivor rule.
   */
  async transport(target: RemoteTarget): Promise<RemoteDaemonTransport> {
    const { RemoteDaemonTransport } = await remoteClient()
    const transport = new RemoteDaemonTransport(target, {
      sshPath: this.ssh,
      forwardTimeoutMs: 10_000,
      helloTimeoutMs: 5_000,
    })
    this.transports.push(transport)
    return transport
  }

  async teardown(): Promise<void> {
    for (const transport of this.transports) transport.dispose()
    const failures: string[] = []
    // Forwards the SDK or CLI left behind count as leaks, like any other owned process.
    for (const call of await this.calls()) {
      if (call.forwarding && (await isRunning(call.pid))) await this.ade.ledger.own(call.pid, 'fake ssh forward')
    }
    for (const host of this.hosts) failures.push(...(await host.stop(this.ade)))
    if (failures.length) throw new Error(`Remote hosts did not stop cleanly:\n${failures.join('\n')}`)
  }

  private async saveConfig(): Promise<void> {
    const hosts = Object.fromEntries(this.hosts.map((host) => [host.name, { root: host.root, env: host.env }]))
    await writeFile(join(this.bin, 'hosts.json'), JSON.stringify({ hosts }))
  }
}

export const test = base.extend<{ remote: RemoteLab }>({
  remote: async ({ ade }, use) => {
    const lab = await RemoteLab.create(ade)
    await use(lab)
    await lab.teardown()
  },
})
