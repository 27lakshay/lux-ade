#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DaemonRequestError, requestDaemon, type KnownDaemonErrorCode } from '@ade/client'
import { socketProfileId } from '@ade/client/journals'
import { accountUsage, runAccountCommand } from './commands/accounts.js'
import { accountSwitchUsage, runAccountSwitchCommand } from './commands/account-switch.js'
import { adapterUsage, runAdapterCommand } from './commands/adapters.js'
import { browserUsage, runBrowserCommand } from './commands/browser.js'
import { checkpointUsage, runCheckpointCommand } from './commands/checkpoints.js'
import { conversationUsage, runConversationCommand } from './commands/conversations.js'
import { contextUsage, runContextCommand } from './commands/context.js'
import { conversationControlUsage, runConversationControlCommand } from './commands/conversation-controls.js'
import { diagnosticsUsage, runDiagnosticsCommand } from './commands/diagnostics.js'
import { draftUsage, runDraftCommand } from './commands/drafts.js'
import { deviceUsage, runDeviceCommand } from './commands/devices.js'
import { resourcesUsage, runResourcesCommand } from './commands/resources.js'
import { remoteUsage, runRemoteCommand } from './commands/remote.js'
import { repositoryUsage, runRepositoryCommand } from './commands/repository.js'
import { placementUsage, runPlacementCommand } from './commands/placement.js'
import { gitUsage, runGitCommand } from './commands/git.js'
import { mcpUsage, runMcpCommand } from './commands/mcp.js'
import { remoteConnectUsage, runRemoteConnectCommand } from './commands/remote-connect.js'
import { orchestrationUsage, runOrchestrationCommand } from './commands/orchestration.js'
import { runRunsCommand, runsUsage } from './commands/runs.js'
import { historyUsage, runHistoryCommand } from './commands/history.js'
import { importUsage, runImportCommand } from './commands/imports.js'
import { runUsageCommand, usageAnalyticsUsage } from './commands/usage.js'
import { providerUsage, runProviderCommand } from './commands/providers.js'
import { retentionUsage, runRetentionCommand } from './commands/retention.js'
import { recoveryUsage, runRecoveryCommand } from './commands/recovery.js'
import { listenerUsage, runListenerCommand, runServiceCommand, serviceUsage } from './commands/services.js'
import { runSkillCommand, skillUsage } from './commands/skills.js'
import { runSlashCommand, slashCommandUsage } from './commands/slash-commands.js'
import { pluginUsage, runPluginCommand } from './commands/plugins.js'
import { pluginDevUsage, runPluginDevCommand } from './commands/plugin-dev.js'
import { hookUsage, runHookCommand } from './commands/hooks.js'
import { attachTerminal, runTerminalCommand, terminalUsage } from './commands/terminals.js'
import { layoutUsage, runLayoutCommand } from './commands/layouts.js'
import { reviewUsage, runReviewCommand } from './commands/review.js'
import { runSettingsCommand, settingsUsage } from './commands/settings.js'
import { runWorkspaceCommand, workspaceUsage } from './commands/workspaces.js'
import { runWorktreeLifecycleCommand, worktreeLifecycleUsage } from './commands/worktrees.js'
import { listOperations, requestUsage, runRequestCommand } from './commands/request.js'
import { activityUsage, runActivityCommand } from './commands/activity.js'
import { attachmentUsage, runAttachmentCommand } from './commands/attachments.js'
import { fileUsage, runFileCommand } from './commands/files.js'
import { queueUsage, runQueueCommand } from './commands/queue.js'
import { runRuntimeCommand, runtimeUsage } from './commands/runtime.js'
import {
  chooseOperationId,
  CliError,
  object,
  selectJournalOwner,
  usedOperationId,
  type CommandResult,
  type ErrorCode,
} from './shared.js'

const usageHeader = `ADE local command line

Usage: ade --profile ID COMMAND [arguments]
       ade profile list
       ade --socket PATH COMMAND [arguments]
       ADE_SOCKET=PATH ade COMMAND [arguments]
       ade [--socket PATH] [--operation-id ID] EFFECT_COMMAND [arguments]

Commands:
  profile list                          Discover managed profiles and their IDs
  status                                Inspect the selected profile daemon
`

const usageFooter = `
Command results are JSON on stdout, except terminal attach streams raw terminal output.
Errors are JSON on stderr: {"type":"error","code","message"}, plus "recovery"
when the daemon names one and "delivery" for a request that reached the socket.
A terminal_busy error also names the running command as "foreground".
A workspace_remove_blocked or worktree_delete_blocked error also lists
"blockers": [{"kind","id","label"}].
"code" is the daemon's own code, kept as sent. Exit codes:
  2  usage, invalid_request             3  unavailable
  4  incompatible                        5  timeout
  6  protocol, or a local failure        7  daemon: any other daemon refusal code
  8  conflict                            9  outcome_unknown, lifecycle_outcome_unknown
  10 in_progress                         11 overloaded
  12 not_applied                         13 needs_rebind
  14 host_resource_conflict              15 host_resources_unavailable
  16 lifecycle_command_failed, lifecycle_unavailable, lifecycle_invalid_output
  17 restored_send_held                  18 conversation_deleted
  19 workspace_not_found, workspace_removed
  20 invalid_workspace_name              21 workspace_remove_blocked
  22 terminal_busy                       23 unsupported
  24 worktree_delete_blocked             25 project_not_found, project_not_repository
  26 unknown_setting                     27 review_anchor_stale
  28 draft_not_empty
  16 also: a workspace worktree operation that ended "failed"
Commands that change state without their own --request-id take the global
--operation-id ID. Without it the CLI generates one, and an error names it as
"operation_id". Retry a lost reply only with that ID and the same command and
arguments: the daemon returns the recorded outcome and never runs it twice.
Choose and retain a unique --request-id for each Git or worktree mutation. If
the reply is lost, inspect its operation with that ID; retry only with the
same command and arguments.
For conversation send, choose a unique --request-id before the first attempt and
reuse it with the same conversation and text after a lost reply. Omitting it
generates an ID, but that ID is unavailable if the reply is lost; do not retry
an uncertain send with a new ID. A prompt the daemon did not answer stays held in
the profile's client journal (with --profile, the profile's client directory;
otherwise ADE_CLIENT_DIR or ~/.ade/client): conversation pending lists held
prompts and conversation deliver sends each once under its original ID. Stage,
unstage, commit and discard are journaled the same way until the daemon's receipt
proves it has them; git recovery shows one that still needs you.
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
  worktreeLifecycleUsage,
  layoutUsage,
  fileUsage,
  conversationUsage,
  conversationControlUsage,
  contextUsage,
  queueUsage,
  attachmentUsage,
  draftUsage,
  historyUsage,
  importUsage,
  usageAnalyticsUsage,
  accountUsage,
  accountSwitchUsage,
  providerUsage,
  adapterUsage,
  terminalUsage,
  browserUsage,
  serviceUsage,
  gitUsage,
  reviewUsage,
  settingsUsage,
  checkpointUsage,
  repositoryUsage,
  listenerUsage,
  mcpUsage,
  remoteUsage,
  placementUsage,
  skillUsage,
  slashCommandUsage,
  pluginUsage,
  pluginDevUsage,
  hookUsage,
  orchestrationUsage,
  runsUsage,
  diagnosticsUsage,
  runtimeUsage,
  activityUsage,
  remoteConnectUsage,
  retentionUsage,
  recoveryUsage,
  deviceUsage,
  resourcesUsage,
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
    } else if (word === '--operation-id' && words.length === 0) {
      // Global only before the command; some commands take their own --operation-id.
      chooseOperationId(argv[++index] ?? '')
    } else if (word.startsWith('--operation-id=') && words.length === 0) {
      chooseOperationId(word.slice('--operation-id='.length))
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
  const binary =
    override ??
    (repositoryCli ? join(repositoryRoot, 'target/debug/ade-control') : join(dirname(cliPath), 'ade-control'))
  const profilesHome =
    process.env.ADE_PROFILES_HOME ??
    (repositoryCli && !override ? join(repositoryRoot, '.ade/dev-profiles-v2') : undefined)
  const daemon = process.env.ADE_DAEMON_BIN
  if (daemon !== undefined && !isAbsolute(daemon)) {
    throw new CliError('usage', 'ADE_DAEMON_BIN must be an absolute executable path.')
  }
  return {
    binary,
    args: [
      'profiles',
      ...(profilesHome ? ['--home', profilesHome] : []),
      ...(action === 'start' && daemon ? ['--daemon', daemon] : []),
      action,
      ...(profileId ? [profileId] : []),
    ],
  }
}

async function controlProfiles(action: 'list' | 'start', profileId?: string): Promise<Record<string, unknown>> {
  const { binary, args } = controlArgs(action, profileId)
  const packaged = basename(dirname(binary)) === 'MacOS' && basename(resolve(dirname(binary), '..')) === 'Contents'
  const environment = packaged
    ? {
        ...process.env,
        ADE_NODE_BIN: join(dirname(binary), 'Lux ADE'),
        ADE_BUN_BIN: resolve(dirname(binary), '../Resources/bin/bun'),
        ADE_CONTROL_PACKAGED: '1',
        ELECTRON_RUN_AS_NODE: '1',
      }
    : process.env
  let stdout: string
  try {
    stdout = (await execFileAsync(binary, args, { timeout: 35_000, maxBuffer: 1024 * 1024, env: environment })).stdout
  } catch (error) {
    const failure = error as Error & { code?: string; killed?: boolean; stderr?: string }
    if (failure.code === 'ENOENT' || failure.code === 'EACCES') {
      throw new CliError('unavailable', `Profile controller is unavailable at ${binary}.`)
    }
    if (failure.killed)
      throw new CliError('timeout', 'Profile controller timed out; inspect the selected profile before retrying.')
    throw new CliError('daemon', failure.stderr?.trim() || 'Profile controller failed.')
  }
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new CliError('protocol', 'Profile controller returned invalid JSON.')
  }
  return object(value)
}

async function managedProfiles(): Promise<Record<string, unknown>> {
  const result = await controlProfiles('list')
  if (
    result.type !== 'profiles' ||
    !Array.isArray(result.profiles) ||
    !(result.selected_id === null || typeof result.selected_id === 'string') ||
    result.profiles.some(
      (profile) =>
        !profile ||
        typeof profile !== 'object' ||
        typeof profile.id !== 'string' ||
        typeof profile.name !== 'string' ||
        typeof profile.home !== 'string' ||
        typeof profile.selected !== 'boolean',
    )
  ) {
    throw new CliError('protocol', 'Profile controller returned an invalid profile list.')
  }
  return result
}

async function profileSocket(profileId: string): Promise<{ socket: string; home: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(profileId)) {
    throw new CliError('invalid_request', 'Profile ID must be a UUID from profile list.')
  }
  const listed = await managedProfiles()
  if (!(listed.profiles as Array<{ id: string }>).some((profile) => profile.id === profileId)) {
    throw new CliError('invalid_request', 'Profile ID is not registered on this host.')
  }
  const started = await controlProfiles('start', profileId)
  if (
    started.type !== 'profile_started' ||
    !started.profile ||
    typeof started.profile !== 'object' ||
    (started.profile as Record<string, unknown>).id !== profileId ||
    typeof started.socket !== 'string' ||
    !isAbsolute(started.socket)
  ) {
    throw new CliError('protocol', 'Profile controller started an unexpected profile or returned an invalid socket.')
  }
  const home = (started.profile as Record<string, unknown>).home
  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new CliError('protocol', 'Profile controller returned an invalid profile home.')
  }
  return { socket: started.socket, home }
}

/**
 * Where this invocation's client journals live. A managed profile keeps them in
 * its client directory, beside its runtime home. A daemon reached by socket alone
 * keeps them under `ADE_CLIENT_DIR` (relative to the working directory), or the
 * user's `~/.ade/client`, named for the socket. Only commands that use the
 * journals ask, so a bad `ADE_CLIENT_DIR` never breaks any other command.
 */
function journalOwner(profileId: string | undefined, endpoint: string, home: string | undefined) {
  return () => {
    if (profileId && home) return { profileId, directory: join(dirname(home), 'client') }
    const id = socketProfileId(endpoint)
    const override = process.env.ADE_CLIENT_DIR
    if (override !== undefined && (!override || override.includes('\0'))) {
      throw new CliError('usage', 'ADE_CLIENT_DIR must name a directory.')
    }
    return { profileId: id, directory: override ? resolve(override) : join(homedir(), '.ade', 'client', id) }
  }
}

// Each command area in the order `run` consults it; an area returns undefined when it does not match.
const commandAreas = [
  runWorkspaceCommand,
  runWorktreeLifecycleCommand,
  runLayoutCommand,
  runConversationCommand,
  runConversationControlCommand,
  runContextCommand,
  runDraftCommand,
  runHistoryCommand,
  runImportCommand,
  runUsageCommand,
  runProviderCommand,
  runAccountCommand,
  runAccountSwitchCommand,
  runAdapterCommand,
  runTerminalCommand,
  runBrowserCommand,
  runServiceCommand,
  runGitCommand,
  runReviewCommand,
  runSettingsCommand,
  runCheckpointCommand,
  runRepositoryCommand,
  runListenerCommand,
  runMcpCommand,
  runRemoteCommand,
  runPlacementCommand,
  runSkillCommand,
  runSlashCommand,
  runPluginDevCommand,
  runPluginCommand,
  runHookCommand,
  runOrchestrationCommand,
  runRunsCommand,
  runDiagnosticsCommand,
  runRetentionCommand,
  runRecoveryCommand,
  runDeviceCommand,
  runFileCommand,
  runQueueCommand,
  runAttachmentCommand,
  runRuntimeCommand,
  runActivityCommand,
  runRequestCommand,
  runResourcesCommand,
] as const

async function run(socketPath: string, words: string[]): Promise<CommandResult> {
  const [area, action, ...rest] = words
  if (area === 'status' && !action) return requestDaemon(socketPath, 'hello')
  for (const command of commandAreas) {
    const result = await command(socketPath, area, action, rest)
    if (result !== undefined) return result
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
    const catalog = listOperations(words)
    if (catalog) return void process.stdout.write(`${JSON.stringify(catalog)}\n`)
    if (words[0] === 'remote' && (words[1] === 'status' || words[1] === 'request')) {
      return void process.stdout.write(`${JSON.stringify(await runRemoteConnectCommand(words.slice(1)))}\n`)
    }
    const managed = profileId ? await profileSocket(profileId) : undefined
    const endpoint = managed?.socket ?? socketPath
    if (!endpoint) throw new CliError('usage', 'Select a profile with --profile ID, --socket PATH or ADE_SOCKET.')
    selectJournalOwner(journalOwner(profileId, endpoint, managed?.home))
    if (words[0] === 'terminal' && words[1] === 'attach') {
      await attachTerminal(endpoint, words)
      return
    }
    process.stdout.write(`${JSON.stringify(await run(endpoint, words))}\n`)
  } catch (error) {
    const code: string = error instanceof DaemonRequestError || error instanceof CliError ? error.code : 'protocol'
    const message = error instanceof Error ? error.message : String(error)
    const daemon = error instanceof DaemonRequestError ? error : null
    process.stderr.write(
      `${JSON.stringify({
        type: 'error',
        code,
        message,
        ...(daemon?.recovery ? { recovery: daemon.recovery } : {}),
        ...(Array.isArray(daemon?.details.blockers) ? { blockers: daemon.details.blockers } : {}),
        ...(daemon && 'foreground' in daemon.details ? { foreground: daemon.details.foreground } : {}),
        ...(daemon ? { delivery: daemon.delivery } : {}),
        ...(daemon && usedOperationId() ? { operation_id: usedOperationId() } : {}),
      })}\n`,
    )
    // A daemon code without its own exit keeps `daemon`'s; a local failure without one is `protocol`'s.
    process.exitCode = Object.hasOwn(exitCodes, code)
      ? exitCodes[code as keyof typeof exitCodes]
      : daemon?.replied
        ? exitCodes.daemon
        : exitCodes.protocol
  }
}

/** The exit code for each error code, as the usage text documents it. */
const exitCodes: Record<ErrorCode | KnownDaemonErrorCode, number> = {
  usage: 2,
  invalid_request: 2,
  unavailable: 3,
  incompatible: 4,
  timeout: 5,
  protocol: 6,
  daemon: 7,
  conflict: 8,
  outcome_unknown: 9,
  in_progress: 10,
  overloaded: 11,
  not_applied: 12,
  needs_rebind: 13,
  host_resource_conflict: 14,
  host_resources_unavailable: 15,
  lifecycle_command_failed: 16,
  lifecycle_unavailable: 16,
  lifecycle_invalid_output: 16,
  lifecycle_outcome_unknown: 9,
  restored_send_held: 17,
  conversation_deleted: 18,
  workspace_not_found: 19,
  workspace_removed: 19,
  invalid_workspace_name: 20,
  workspace_remove_blocked: 21,
  terminal_busy: 22,
  unsupported: 23,
  worktree_delete_blocked: 24,
  project_not_found: 25,
  project_not_repository: 25,
  unknown_setting: 26,
  review_anchor_stale: 27,
  draft_not_empty: 28,
}

void main()
