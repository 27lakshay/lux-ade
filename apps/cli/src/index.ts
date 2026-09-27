#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DaemonRequestError, requestDaemon } from '@ade/client'
import { accountUsage, runAccountCommand } from './commands/accounts.js'
import { browserUsage, runBrowserCommand } from './commands/browser.js'
import { conversationUsage, runConversationCommand } from './commands/conversations.js'
import { diagnosticsUsage, runDiagnosticsCommand } from './commands/diagnostics.js'
import { remoteUsage, runRemoteCommand } from './commands/remote.js'
import { gitUsage, runGitCommand } from './commands/git.js'
import { mcpUsage, runMcpCommand } from './commands/mcp.js'
import { orchestrationUsage, runOrchestrationCommand } from './commands/orchestration.js'
import { historyUsage, runHistoryCommand } from './commands/history.js'
import { listenerUsage, runListenerCommand, runServiceCommand, serviceUsage } from './commands/services.js'
import { runSkillCommand, skillUsage } from './commands/skills.js'
import { pluginUsage, runPluginCommand } from './commands/plugins.js'
import { attachTerminal, runTerminalCommand, terminalUsage } from './commands/terminals.js'
import { runWorkspaceCommand, workspaceUsage } from './commands/workspaces.js'
import { CliError, jsonObject, object, required, type CommandResult, type ErrorCode } from './shared.js'

const usageHeader = `ADE local command line

Usage: ade --profile ID COMMAND [arguments]
       ade profile list
       ade --socket PATH COMMAND [arguments]
       ADE_SOCKET=PATH ade COMMAND [arguments]

Commands:
  profile list                          Discover managed profiles and their IDs
  status                                Inspect the selected profile daemon
`

const requestUsage = `  request OP [JSON_OBJECT]              Call another daemon command
`

const usageFooter = `
Command results are JSON on stdout, except terminal attach streams raw terminal output.
Errors are JSON on stderr.
Choose and retain a unique --request-id for each Git or worktree mutation. If
the reply is lost, inspect its operation with that ID; retry only with the
same command and arguments.
For conversation send, choose a unique --request-id before the first attempt and
reuse it with the same conversation and text after a lost reply. Omitting it
generates an ID, but that ID is unavailable if the reply is lost; do not retry
an uncertain send with a new ID.
Terminal send appends Enter. Terminal attach needs a TTY and relays raw input and output.
Use --profile ID to start or attach to that exact managed profile. It does not
change the desktop's selected profile. --profile conflicts with --socket and
ADE_SOCKET. ADE_PROFILES_HOME selects the same registry as the desktop; the
repository CLI defaults to .ade/dev-profiles-v2. ADE_CONTROL_BIN can explicitly
select an installed app's Contents/MacOS/ade-control executable. Remote hosts
and stable public command schemas remain open.
Authenticate the returned native home with the provider CLI:
  Claude: CLAUDE_CONFIG_DIR=<native_home> claude auth login
  Codex:  env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" CODEX_HOME=<native_home> codex login
  Oh My Pi: (cd <native_home> && env -i HOME="$PWD" PATH="$PATH" TERM="$TERM" PI_CODING_AGENT_DIR="$PWD" sh -c 'test "$(omp --version)" = "omp/18.3.0" || { echo "ADE needs Oh My Pi 18.3.0" >&2; exit 1; }; exec omp login')
             Choose one OAuth provider; managed API keys and multiple credentials are not supported yet.
Then run account inspect and account verify with the inspected identity JSON.
ADE never receives the login token.
`

// The help text is assembled from each command area's fragment in this fixed order.
const usage = [
  usageHeader,
  workspaceUsage,
  conversationUsage,
  historyUsage,
  accountUsage,
  terminalUsage,
  browserUsage,
  serviceUsage,
  gitUsage,
  listenerUsage,
  mcpUsage,
  skillUsage,
  pluginUsage,
  orchestrationUsage,
  diagnosticsUsage,
  remoteUsage,
  requestUsage,
  usageFooter,
].join('')

function parseArgs(argv: string[]): { socketPath: string | undefined; profileId: string | undefined; words: string[] } {
  let socketPath: string | undefined = process.env.ADE_SOCKET
  let profileId: string | undefined
  const words: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--socket') {
      socketPath = argv[++index]
      if (!socketPath) throw new CliError('usage', '--socket requires a path.')
    } else if (word.startsWith('--socket=')) {
      socketPath = word.slice('--socket='.length)
      if (!socketPath) throw new CliError('usage', '--socket requires a path.')
    } else if (word === '--profile') {
      if (profileId !== undefined) throw new CliError('usage', '--profile may be supplied only once.')
      profileId = argv[++index]
      if (!profileId || profileId.startsWith('--')) throw new CliError('usage', '--profile requires an ID.')
    } else if (word.startsWith('--profile=')) {
      if (profileId !== undefined) throw new CliError('usage', '--profile may be supplied only once.')
      profileId = word.slice('--profile='.length)
      if (!profileId) throw new CliError('usage', '--profile requires an ID.')
    } else {
      words.push(word)
    }
  }
  if (socketPath && profileId) throw new CliError('usage', '--profile conflicts with --socket and ADE_SOCKET.')
  return { socketPath, profileId, words }
}

const execFileAsync = promisify(execFile)
const cliPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(cliPath), '../../..')
const repositoryCli = cliPath === join(repositoryRoot, 'apps/cli/dist/index.js')

function controlArgs(action: 'list' | 'start', profileId?: string): { binary: string; args: string[] } {
  const override = process.env.ADE_CONTROL_BIN
  if (override !== undefined && !isAbsolute(override)) {
    throw new CliError('usage', 'ADE_CONTROL_BIN must be an absolute executable path.')
  }
  const binary = override ?? (repositoryCli ? join(repositoryRoot, 'target/debug/ade-control') :
    join(dirname(cliPath), 'ade-control'))
  const profilesHome = process.env.ADE_PROFILES_HOME ?? (repositoryCli && !override
    ? join(repositoryRoot, '.ade/dev-profiles-v2') : undefined)
  const daemon = process.env.ADE_DAEMON_BIN
  if (daemon !== undefined && !isAbsolute(daemon)) {
    throw new CliError('usage', 'ADE_DAEMON_BIN must be an absolute executable path.')
  }
  return { binary, args: ['profiles', ...(profilesHome ? ['--home', profilesHome] : []),
    ...(action === 'start' && daemon ? ['--daemon', daemon] : []), action,
    ...(profileId ? [profileId] : [])] }
}

async function controlProfiles(action: 'list' | 'start', profileId?: string): Promise<Record<string, unknown>> {
  const { binary, args } = controlArgs(action, profileId)
  const packaged = basename(dirname(binary)) === 'MacOS' && basename(resolve(dirname(binary), '..')) === 'Contents'
  const environment = packaged ? {
    ...process.env,
    ADE_NODE_BIN: join(dirname(binary), 'Lux ADE'),
    ADE_BUN_BIN: resolve(dirname(binary), '../Resources/bin/bun'),
    ADE_CONTROL_PACKAGED: '1',
    ELECTRON_RUN_AS_NODE: '1',
  } : process.env
  let stdout: string
  try {
    stdout = (await execFileAsync(binary, args, { timeout: 35_000, maxBuffer: 1024 * 1024,
      env: environment })).stdout
  } catch (error) {
    const failure = error as Error & { code?: string; killed?: boolean; stderr?: string }
    if (failure.code === 'ENOENT' || failure.code === 'EACCES') {
      throw new CliError('unavailable', `Profile controller is unavailable at ${binary}.`)
    }
    if (failure.killed) throw new CliError('timeout', 'Profile controller timed out; inspect the selected profile before retrying.')
    throw new CliError('daemon', failure.stderr?.trim() || 'Profile controller failed.')
  }
  let value: unknown
  try { value = JSON.parse(stdout) }
  catch { throw new CliError('protocol', 'Profile controller returned invalid JSON.') }
  return object(value)
}

async function managedProfiles(): Promise<Record<string, unknown>> {
  const result = await controlProfiles('list')
  if (result.type !== 'profiles' || !Array.isArray(result.profiles) ||
    !(result.selected_id === null || typeof result.selected_id === 'string') ||
    result.profiles.some((profile) => !profile || typeof profile !== 'object' ||
      typeof profile.id !== 'string' || typeof profile.name !== 'string' ||
      typeof profile.home !== 'string' || typeof profile.selected !== 'boolean')) {
    throw new CliError('protocol', 'Profile controller returned an invalid profile list.')
  }
  return result
}

async function profileSocket(profileId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(profileId)) {
    throw new CliError('invalid_request', 'Profile ID must be a UUID from profile list.')
  }
  const listed = await managedProfiles()
  if (!(listed.profiles as Array<{ id: string }>).some((profile) => profile.id === profileId)) {
    throw new CliError('invalid_request', 'Profile ID is not registered on this host.')
  }
  const started = await controlProfiles('start', profileId)
  if (started.type !== 'profile_started' ||
    !started.profile || typeof started.profile !== 'object' ||
    (started.profile as Record<string, unknown>).id !== profileId ||
    typeof started.socket !== 'string' || !isAbsolute(started.socket)) {
    throw new CliError('protocol', 'Profile controller started an unexpected profile or returned an invalid socket.')
  }
  return started.socket
}

// Each command area in the order `run` consults it; an area returns undefined when it does not match.
const commandAreas = [
  runWorkspaceCommand,
  runConversationCommand,
  runHistoryCommand,
  runAccountCommand,
  runTerminalCommand,
  runBrowserCommand,
  runServiceCommand,
  runGitCommand,
  runListenerCommand,
  runMcpCommand,
  runSkillCommand,
  runPluginCommand,
  runOrchestrationCommand,
  runDiagnosticsCommand,
] as const

async function run(socketPath: string, words: string[]): Promise<CommandResult> {
  const [area, action, ...rest] = words
  if (area === 'status' && !action) return requestDaemon(socketPath, 'hello')
  for (const command of commandAreas) {
    const result = await command(socketPath, area, action, rest)
    if (result !== undefined) return result
  }
  if (area === 'request') {
    const op = required(action, 'OP')
    return requestDaemon(socketPath, op, rest[0] ? jsonObject(rest[0], 'JSON_OBJECT') : {})
  }
  throw new CliError('usage', 'Unknown command or missing arguments. Run ade --help for usage.')
}

async function main(): Promise<void> {
  try {
    const { socketPath, profileId, words } = parseArgs(process.argv.slice(2))
    if (words.length === 0 || words[0] === '--help' || words[0] === '-h' || words[0] === 'help') {
      process.stdout.write(usage)
      return
    }
    if (words[0] === 'profile' && words[1] === 'list' && words.length === 2) {
      if (socketPath || profileId) throw new CliError('usage', 'profile list does not accept --socket or --profile.')
      process.stdout.write(`${JSON.stringify(await managedProfiles())}\n`)
      return
    }
    if (words[0] === 'remote') return void process.stdout.write(`${JSON.stringify(await runRemoteCommand(words.slice(1)))}\n`)
    const endpoint = profileId ? await profileSocket(profileId) : socketPath
    if (!endpoint) throw new CliError('usage', 'Select a profile with --profile ID, --socket PATH or ADE_SOCKET.')
    if (words[0] === 'terminal' && words[1] === 'attach') {
      await attachTerminal(endpoint, words)
      return
    }
    process.stdout.write(`${JSON.stringify(await run(endpoint, words))}\n`)
  } catch (error) {
    const code = error instanceof DaemonRequestError || error instanceof CliError ? error.code : 'protocol'
    const message = error instanceof Error ? error.message : String(error)
    const exitCodes: Record<ErrorCode, number> = {
      usage: 2, invalid_request: 2, unavailable: 3, incompatible: 4, timeout: 5, protocol: 6,
      daemon: 7, conflict: 8, outcome_unknown: 9, in_progress: 10, overloaded: 11, not_applied: 12,
    }
    process.stderr.write(`${JSON.stringify({ type: 'error', code, message,
      ...(error instanceof DaemonRequestError ? { delivery: error.delivery } : {}) })}\n`)
    process.exitCode = exitCodes[code as ErrorCode] ?? 6
  }
}

void main()
