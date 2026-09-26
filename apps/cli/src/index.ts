#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, open, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  DaemonRequestError,
  formatReviewFeedback,
  openTerminalConnection,
  requestDaemon,
  type DaemonResponse,
  type ReviewFeedback,
  type TerminalConnection,
  type TerminalFrame,
} from '@ade/client'

const usage = `ADE local command line

Usage: ade --profile ID COMMAND [arguments]
       ade profile list
       ade --socket PATH COMMAND [arguments]
       ADE_SOCKET=PATH ade COMMAND [arguments]

Commands:
  profile list                          Discover managed profiles and their IDs
  status                                Inspect the selected profile daemon
  workspace list                        List registered workspaces
  workspace open PATH                   Register a repository or folder
  workspace rebind WORKSPACE_ID PATH    Bind a restored workspace to a verified directory
  repository rebind REPOSITORY_ID PATH  Bind a restored Git repository before its workspaces
  worktree register PATH                Register a Git repository lifecycle
  worktree list REPOSITORY_ID           Inspect linked trees and removal authority
  worktree create REPOSITORY_ID BRANCH BASE [PATH] --request-id ID
                                        Create a branch and linked tree
  worktree adopt REPOSITORY_ID PATH CONFIRM_PATH
                                        Explicitly take ADE removal authority
  worktree remove REPOSITORY_ID PATH [--delete-merged] --request-id ID
                                        Remove a clean ADE-authorized tree
  worktree operation REPOSITORY_ID REQUEST_ID
                                        Inspect a lifecycle operation receipt
  worktree rebind-list                  List restored lifecycle repositories requiring a path
  worktree rebind REPOSITORY_ID PATH    Bind restored Git lifecycle history first
  conversation list [WORKSPACE_ID]      List conversations
  conversation inspect ID               Read conversation and recent messages
  conversation export ID FILE            Write complete readable JSON history to a new file
  conversation create WORKSPACE_ID [PROVIDER] [TITLE] [--account ID]
  conversation send ID TEXT [--request-id ID]
                                        Send a prompt; retain ID for safe lost-reply retries
  conversation cancel ID                Request cancellation of the active turn
  conversation resume ID                Reconnect or resume a stopped agent
  conversation answer ID REQUEST_ID DECISION [ANSWERS_JSON]
                                        Answer a pending native request once; DECISION is accept, decline, cancel, or answer
                                        For questions, pass a JSON object of question IDs to text or text arrays
  account list                           List profile accounts
  account create PROVIDER NAME           Register a native account home
  account inspect ID                     Check current Claude, Codex or Oh My Pi readiness
  account verify ID EXPECTED_GENERATION IDENTITY_JSON
                                        Pin only the identity returned by account inspect
  account disable ID                     Disable new ADE launches; does not log out native CLI or stop running agents
  terminal list                         List workspace terminals
  terminal create WORKSPACE_ID --request-id ID
                                        Create another terminal; reuse ID after a lost reply
  terminal operation WORKSPACE_ID REQUEST_ID
                                        Inspect a terminal creation receipt
  terminal inspect WORKSPACE_ID TERMINAL_ID
  terminal attach WORKSPACE_ID TERMINAL_ID
                                        Attach this TTY; press Ctrl-] to detach without stopping the shell
  terminal send WORKSPACE_ID TERMINAL_ID TEXT
  terminal resize WORKSPACE_ID TERMINAL_ID COLS ROWS
  terminal stop WORKSPACE_ID TERMINAL_ID
                                        Stop the selected terminal shell
  terminal retire WORKSPACE_ID TERMINAL_ID
                                        Remove a stopped terminal from the workspace
  browser owner                         Inspect the selected profile's live browser owner
  browser list OWNER_ID                 List tabs under that exact owner
  browser inspect OWNER_ID TAB_ID       Inspect one exact browser tab
  browser open OWNER_ID URL --request-id ID
  browser navigate OWNER_ID TAB_ID URL --request-id ID
  browser close OWNER_ID TAB_ID --request-id ID
  browser operation REQUEST_ID          Inspect a browser mutation receipt
  service list WORKSPACE_ID             List managed services and execution state
  service configure WORKSPACE_ID NAME JSON_CONFIG [REVISION]
                                        Save a service recipe; revision defaults to 0
  service start WORKSPACE_ID NAME       Launch a configured service
  service stop WORKSPACE_ID NAME        Stop and reap a managed service
  service inspect WORKSPACE_ID NAME [TAIL_BYTES]
                                        Read execution, listener evidence and bounded output
  service url WORKSPACE_ID NAME PORT_VARIABLE
                                        Ensure a stable local HTTP/WebSocket URL
  service url-inspect WORKSPACE_ID NAME PORT_VARIABLE
                                        Inspect a stable URL and its pinned service identity
  service remap WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_ROUTE_ID EXPECTED_ROUTE_PORT
                                        Remap only if both reviewed targets still match
  service url-retire WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT
                                        Retire exactly one reviewed stable URL
  service url-recovery                    Inspect blocked routes or a corrupt proxy registry
  service url-retry WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT
                                        Rebind only the reviewed route's original port
  service url-recovery-reset EXPECTED_REGISTRY_SHA256 --confirm-reset
                                        Archive and reset an inspected corrupt registry
  script list WORKSPACE_ID               Discover package scripts in a workspace
  script runs WORKSPACE_ID               List retained script runs
  script start WORKSPACE_ID NAME         Run a configured workspace script
  script inspect WORKSPACE_ID RUN_ID [TAIL_BYTES]
                                        Read script state and bounded output
  script stop WORKSPACE_ID RUN_ID        Stop a script and confirm process exit
  script retire WORKSPACE_ID RUN_ID      Release an exited script run
  git status WORKSPACE_ID                Read fresh Git status and revision tokens
  git diff WORKSPACE_ID PATH [--staged]  Read a file diff and its preview token
  git diff-page WORKSPACE_ID PATH SIDE [--cursor CURSOR --expected-token TOKEN]
                                        Page a large diff; SIDE is staged or unstaged
  git feedback-search WORKSPACE_ID [--path PATH] [--query TEXT] [--limit 1..50] [--before CURSOR]
                                        Search saved review notes by file or note text
  git feedback-send CONVERSATION_ID REQUEST_ID FEEDBACK_JSON
                                        Send structured anchored review notes once
  git stage WORKSPACE_ID PATH REVISION --request-id ID
  git unstage WORKSPACE_ID PATH REVISION --request-id ID
                                        Change exactly one reviewed file
  git discard WORKSPACE_ID PATH REVISION DIFF_TOKEN --request-id ID
                                        Discard one previewed unstaged change
  git commit WORKSPACE_ID MESSAGE INDEX_TOKEN --request-id ID
                                        Commit the reviewed staged index
  git operation WORKSPACE_ID REQUEST_ID  Inspect a Git operation receipt
  listener list                         Observe local TCP listeners and service assignments
  request OP [JSON_OBJECT]              Call another daemon command

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

type ErrorCode = 'usage' | 'unavailable' | 'incompatible' | 'timeout' | 'protocol' | 'daemon' | 'invalid_request'

class CliError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message)
  }
}

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

function required(value: string | undefined, label: string): string {
  if (!value) throw new CliError('usage', `${label} is required.`)
  return value
}

function integer(value: string | undefined, label: string): number {
  const number = Number(value)
  if (!value || !Number.isInteger(number) || number < 2 || number > 1000) {
    throw new CliError('usage', `${label} must be an integer from 2 to 1000.`)
  }
  return number
}

function revision(value: string | undefined): number {
  if (value === undefined) return 0
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new CliError('usage', 'REVISION must be a nonnegative integer.')
  return number
}

function generation(value: string | undefined): number {
  if (value === undefined) throw new CliError('usage', 'EXPECTED_GENERATION is required.')
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliError('usage', 'EXPECTED_GENERATION must be a nonnegative integer.')
  }
  return number
}

function tailBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > 32768) {
    throw new CliError('usage', 'TAIL_BYTES must be an integer from 1 to 32768.')
  }
  return number
}

function port(value: string | undefined, label: string): number {
  const number = Number(value)
  if (!value || !Number.isSafeInteger(number) || number < 1 || number > 65535) {
    throw new CliError('usage', `${label} must be a TCP port from 1 to 65535.`)
  }
  return number
}

function sha256(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new CliError('usage', 'EXPECTED_REGISTRY_SHA256 must be 64 lowercase hexadecimal characters from service url-recovery.')
  }
  return value
}

function reviewSearchLimit(value: string): number {
  const number = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number) || number > 50) {
    throw new CliError('usage', 'LIMIT must be an integer from 1 to 50.')
  }
  return number
}

function reviewSearchCursor(value: string): number {
  const number = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new CliError('usage', 'CURSOR must be a positive integer returned by feedback-search.')
  }
  return number
}

function namedOptions(words: string[], allowed: readonly string[], command: string): Record<string, string> {
  const options: Record<string, string> = {}
  for (let index = 0; index < words.length; index += 2) {
    const key = words[index]
    const value = words[index + 1]
    if (!allowed.includes(key) || !value || value.startsWith('--') || options[key] !== undefined) {
      throw new CliError('usage', `Invalid ${command} option. Run ade --help for usage.`)
    }
    options[key] = value
  }
  return options
}

function reviewFeedback(value: string | undefined): ReviewFeedback {
  const feedback = jsonObject(value, 'FEEDBACK_JSON')
  const keys = Object.keys(feedback)
  if (Buffer.byteLength(JSON.stringify(feedback)) > 64 * 1024 || keys.length !== 3 ||
    !keys.includes('format') || !keys.includes('workspace_id') || !keys.includes('notes') ||
    feedback.format !== 'ade-review-feedback-v1' ||
    typeof feedback.workspace_id !== 'string' || !feedback.workspace_id ||
    !Array.isArray(feedback.notes) || feedback.notes.length < 1 || feedback.notes.length > 16) {
    throw new CliError('usage', 'FEEDBACK_JSON must be bounded ade-review-feedback-v1 with 1 to 16 notes.')
  }
  for (const entry of feedback.notes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 || !('anchor' in entry) || !('note' in entry) ||
      typeof entry.note !== 'string' || !entry.note.trim() || Buffer.byteLength(entry.note) > 4096 ||
      !entry.anchor || typeof entry.anchor !== 'object' || Array.isArray(entry.anchor)) {
      throw new CliError('usage', 'Each review note needs an anchor and 1 to 4096 bytes of text.')
    }
    const anchor = entry.anchor as Record<string, unknown>
    if (Object.keys(anchor).some((key) => !['workspace_id', 'path', 'staged', 'revision', 'token',
      'hunk', 'line', 'text', 'end_line', 'end_text'].includes(key)) ||
      anchor.workspace_id !== feedback.workspace_id ||
      typeof anchor.path !== 'string' || !anchor.path ||
      typeof anchor.staged !== 'boolean' ||
      typeof anchor.revision !== 'string' || !/^[0-9a-f]{16}$/.test(anchor.revision) ||
      typeof anchor.token !== 'string' || !/^[0-9a-f]{16}$/.test(anchor.token) ||
      typeof anchor.hunk !== 'string' || !anchor.hunk.startsWith('@@ ') || anchor.hunk.length > 512 ||
      !Number.isSafeInteger(anchor.line) || (anchor.line as number) < 1 ||
      typeof anchor.text !== 'string' || Buffer.byteLength(anchor.text) > 8192 ||
      (anchor.end_line !== undefined || anchor.end_text !== undefined) &&
      (!Number.isSafeInteger(anchor.end_line) || (anchor.end_line as number) < (anchor.line as number) ||
        (anchor.end_line as number) - (anchor.line as number) >= 1000 ||
        typeof anchor.end_text !== 'string' || Buffer.byteLength(anchor.end_text) > 8192)) {
      throw new CliError('usage', 'Review anchors need a workspace, file, side, revision, token and selected line or range.')
    }
  }
  return feedback as ReviewFeedback
}

async function sendReviewFeedback(socketPath: string, conversationId: string,
  requestId: string, feedback: ReviewFeedback): Promise<Record<string, unknown>> {
  const text = formatReviewFeedback(feedback)
  // A request gets its own durable draft owner, separate from every GUI window.
  const windowId = `cli-review-${createHash('sha256').update(conversationId).update('\0')
    .update(requestId).digest('hex')}`
  const owner = { conversation_id: conversationId, window_id: windowId }
  const current = await requestDaemon(socketPath, 'draft.get', owner)
  const draft = object(current.draft)
  if (draft.revision === 0) {
    await requestDaemon(socketPath, 'draft.save', { ...owner, text, revision: 1 })
  }
  await requestDaemon(socketPath, 'draft.send.prepare', {
    ...owner, request_id: requestId, draft_text: text, revision: 1,
    text, review_feedback: feedback,
  })
  const response = await requestDaemon(socketPath, 'agent.send_review', {
    conversation_id: conversationId, request_id: requestId, text, review_feedback: feedback,
  })
  await requestDaemon(socketPath, 'draft.send.complete', { ...owner, request_id: requestId })
  return { ...response, request_id: requestId }
}

function gitMutationArgs(rest: string[], action: 'stage' | 'unstage' | 'commit' | 'discard'): {
  workspaceId: string; value: string; token: string; requestId: string; diffToken?: string
} {
  const flag = rest.length - 2
  const positionals = rest.slice(0, flag)
  if (positionals.length !== (action === 'discard' ? 4 : 3) || rest[flag] !== '--request-id' ||
    !rest[flag + 1] || rest[flag + 1].length > 256) {
    throw new CliError('usage', `git ${action} requires WORKSPACE_ID ${action === 'commit'
      ? 'MESSAGE INDEX_TOKEN' : action === 'discard' ? 'PATH REVISION DIFF_TOKEN' : 'PATH REVISION'} --request-id ID.`)
  }
  return {
    workspaceId: required(positionals[0], 'WORKSPACE_ID'),
    value: required(positionals[1], action === 'commit' ? 'MESSAGE' : 'PATH'),
    token: required(positionals[2], action === 'commit' ? 'INDEX_TOKEN' : 'REVISION'),
    requestId: rest[flag + 1],
    ...(action === 'discard' ? { diffToken: required(positionals[3], 'DIFF_TOKEN') } : {}),
  }
}

function worktreeMutationArgs(rest: string[], action: 'create' | 'remove'): {
  positionals: string[]; requestId: string
} {
  const flag = rest.length - 2
  const positionals = rest.slice(0, flag)
  const valid = action === 'create'
    ? positionals.length === 3 || positionals.length === 4
    : positionals.length === 2 || (positionals.length === 3 && positionals[2] === '--delete-merged')
  if (!valid || rest[flag] !== '--request-id' || !rest[flag + 1] ||
    rest[flag + 1].startsWith('--') || rest[flag + 1].length > 256) {
    throw new CliError('usage', `worktree ${action} requires ${action === 'create'
      ? 'REPOSITORY_ID BRANCH BASE [PATH]' : 'REPOSITORY_ID PATH [--delete-merged]'} --request-id ID.`)
  }
  return { positionals, requestId: rest[flag + 1] }
}

function jsonObject(value: string | undefined, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(required(value, label)) }
  catch { throw new CliError('usage', `${label} must be valid JSON.`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('usage', `${label} must be an object.`)
  return parsed as Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('protocol', 'Daemon returned an invalid object.')
  }
  return value as Record<string, unknown>
}

async function catalog(socketPath: string): Promise<Record<string, unknown>> {
  const result = await requestDaemon(socketPath, 'catalog.get')
  return object(result.catalog)
}

/** Export through the public paginated read without holding the whole transcript in memory. */
async function exportConversation(socketPath: string, conversationId: string, destination: string): Promise<Record<string, unknown>> {
  const pageSize = 100
  const first = await requestDaemon(socketPath, 'conversation.get', { conversation_id: conversationId, limit: pageSize })
  if (first.type !== 'conversation_snapshot') throw new CliError('protocol', 'Daemon returned an unexpected conversation response.')
  const conversation = object(first.conversation)
  if (conversation.id !== conversationId || typeof first.boot_id !== 'string' || !first.boot_id ||
    !Number.isSafeInteger(first.revision) || (first.revision as number) < 0) {
    throw new CliError('protocol', 'Daemon returned invalid conversation identity or revision.')
  }
  const bootId = first.boot_id
  const revision = first.revision
  const conversationRecord = JSON.stringify(conversation)
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(temporary, 'wx', 0o600) }
  catch (error) { throw new CliError('invalid_request', `Cannot create export file: ${String(error)}`) }
  let fileClosed = false
  let count = 0
  let oldest = Number.POSITIVE_INFINITY
  let page = first
  try {
    await file.writeFile(`{\n  "format": "ade-conversation-history-v1",\n  "scope": "conversation-history",\n  "message_order": "newest_first",\n  "boot_id": ${JSON.stringify(bootId)},\n  "revision": ${revision},\n  "conversation": ${JSON.stringify(conversation, null, 2)},\n  "messages": [\n`)
    for (;;) {
      if (page.type !== 'conversation_snapshot' || page.boot_id !== bootId || page.revision !== revision ||
        !page.conversation || typeof page.conversation !== 'object' ||
        (page.conversation as Record<string, unknown>).id !== conversationId ||
        JSON.stringify(page.conversation) !== conversationRecord ||
        !Array.isArray(page.messages) || page.messages.length > pageSize) {
        throw new CliError('protocol', 'Conversation changed or daemon returned an invalid history page; retry the export.')
      }
      const messages = page.messages as unknown[]
      let previous = 0
      for (const value of messages) {
        const message = object(value)
        const sequence = message.sequence
        if (message.conversation_id !== conversationId || typeof message.id !== 'string' || !message.id ||
          !Number.isSafeInteger(sequence) || (sequence as number) <= previous || (sequence as number) >= oldest ||
          typeof message.role !== 'string' || typeof message.kind !== 'string' ||
          typeof message.text !== 'string' || typeof message.status !== 'string') {
          throw new CliError('protocol', 'Daemon returned an invalid or overlapping history page; retry the export.')
        }
        previous = sequence as number
      }
      for (let index = messages.length - 1; index >= 0; index--) {
        await file.writeFile(`${count ? ',\n' : ''}${JSON.stringify(messages[index], null, 2)}`)
        count++
      }
      if (messages.length < pageSize) break
      oldest = (messages[0] as Record<string, unknown>).sequence as number
      page = await requestDaemon(socketPath, 'conversation.get', {
        conversation_id: conversationId, before: oldest, limit: pageSize,
      })
    }
    await file.writeFile('\n  ]\n}\n')
    await file.sync()
    await file.close()
    fileClosed = true
    try { await link(temporary, destination) }
    catch (error) {
      const reason = error as NodeJS.ErrnoException
      throw new CliError('invalid_request', reason.code === 'EEXIST'
        ? 'Export destination already exists; choose a new file.'
        : `Cannot publish export file: ${String(error)}`)
    }
    try {
      const directory = await open(dirname(destination), 'r')
      try { await directory.sync() }
      finally { await directory.close() }
    } catch (error) {
      throw new CliError('invalid_request', `Export was created, but directory sync failed; durability is unconfirmed: ${String(error)}`)
    }
    return { type: 'conversation_export', conversation_id: conversationId, file: destination,
      format: 'ade-conversation-history-v1', message_count: count, boot_id: bootId, revision }
  } catch (error) {
    if (error instanceof CliError || error instanceof DaemonRequestError) throw error
    throw new CliError('invalid_request', `Cannot write export file: ${String(error)}`)
  } finally {
    if (!fileClosed) await file.close()
    await unlink(temporary).catch(() => undefined)
  }
}

async function terminalTarget(socketPath: string, workspaceId: string, terminalId: string): Promise<void> {
  const result = await catalog(socketPath)
  const workspaces = result.workspaces
  if (!Array.isArray(workspaces)) throw new CliError('protocol', 'Daemon catalog has no workspaces.')
  const workspace = workspaces.find((value) => value && typeof value === 'object' && value.id === workspaceId)
  if (!workspace) throw new CliError('invalid_request', 'Workspace is absent from the selected profile.')
  const owned = workspace.terminal_id === terminalId ||
    (Array.isArray(workspace.extra_terminals) && workspace.extra_terminals.includes(terminalId))
  if (!owned) throw new CliError('invalid_request', 'Terminal is absent from the selected workspace.')
}

function terminalAction(
  socketPath: string,
  workspaceId: string,
  terminalId: string,
  action: 'inspect' | 'send' | 'resize',
  data?: string,
  size?: { cols: number; rows: number },
): Promise<TerminalFrame> {
  return new Promise((resolve, reject) => {
    let terminal: TerminalConnection | undefined
    let settled = false
    let sent = false
    const timer = setTimeout(() => fail('timeout', 'Terminal did not respond before the deadline.'), 10_000)
    const finish = (frame: TerminalFrame): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      terminal?.dispose()
      resolve(frame)
    }
    const fail = (code: ErrorCode, message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      terminal?.dispose()
      reject(new CliError(code, message))
    }
    terminal = openTerminalConnection(socketPath, workspaceId, terminalId, (frame) => {
      if (frame.type === 'error') {
        return fail('daemon', typeof frame.message === 'string' ? frame.message : 'Terminal rejected the command.')
      }
      if (frame.type === 'snapshot' && !sent) {
        if (frame.terminal_snapshot_format !== 'xterm-replay-v1') {
          return fail('incompatible', 'Terminal recovery format is incompatible with this CLI.')
        }
        if (action === 'inspect') return finish(frame)
        sent = true
        if (action === 'send') terminal?.input(`${data ?? ''}\n`)
        if (action === 'resize' && size) terminal?.resize(size.cols, size.rows, 0, 0, true)
        terminal?.ping()
        return
      }
      if (sent && frame.type === 'metrics') finish(frame)
    }, (reason) => fail('unavailable', reason))
  })
}

async function attachTerminal(socketPath: string, words: string[]): Promise<void> {
  if (words.length !== 4 || !words[2] || !words[3]) {
    throw new CliError('usage', 'terminal attach requires WORKSPACE_ID TERMINAL_ID.')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new CliError('usage', 'terminal attach requires a TTY on stdin and stdout.')
  }
  const [, , workspaceId, terminalId] = words
  await terminalTarget(socketPath, workspaceId, terminalId)
  await new Promise<void>((resolve, reject) => {
    let terminal: TerminalConnection | undefined
    let ready = false
    let settled = false
    let offset = 0
    const wasRaw = process.stdin.isRaw
    const signalHandlers = {
      SIGINT: () => { setImmediate(() => { detach(); process.exit(130) }) },
      SIGTERM: () => { setImmediate(() => { detach(); process.exit(143) }) },
      SIGHUP: () => { setImmediate(() => { detach(); process.exit(129) }) },
    }
    const timer = setTimeout(() => fail('timeout', 'Terminal did not respond before the deadline.'), 10_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      terminal?.dispose()
      process.stdin.off('data', input)
      process.stdout.off('resize', resize)
      process.off('SIGINT', signalHandlers.SIGINT)
      process.off('SIGTERM', signalHandlers.SIGTERM)
      process.off('SIGHUP', signalHandlers.SIGHUP)
      if (ready) {
        process.stdin.setRawMode(wasRaw)
        process.stdin.pause()
      }
    }
    const detach = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (code: ErrorCode, message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new CliError(code, message))
    }
    const resize = (): void => {
      if (!ready) return
      const cols = process.stdout.columns
      const rows = process.stdout.rows
      if (Number.isInteger(cols) && cols >= 2 && cols <= 1000 &&
        Number.isInteger(rows) && rows >= 2 && rows <= 1000) {
        terminal?.resize(cols, rows, 0, 0, true)
      }
    }
    const write = (bytes: Buffer): void => {
      process.stdout.write(bytes)
      if (process.stdout.writableLength > 8 * 1024 * 1024) {
        fail('protocol', 'Terminal output exceeded the CLI buffer; attach again to recover.')
      }
    }
    const input = (chunk: Buffer): void => {
      const detachAt = chunk.indexOf(0x1d)
      const data = detachAt < 0 ? chunk : chunk.subarray(0, detachAt)
      // Each byte can take four JSON characters ("255,"). Leave ample room below
      // the terminal host's 128 KiB request limit for identities and framing.
      const inputChunkBytes = 16 * 1024
      for (let index = 0; index < data.length; index += inputChunkBytes) {
        terminal?.binary(Array.from(data.subarray(index, index + inputChunkBytes)))
      }
      if (detachAt >= 0) detach()
    }
    terminal = openTerminalConnection(socketPath, workspaceId, terminalId, (frame) => {
      if (frame.type === 'error') {
        fail('daemon', typeof frame.message === 'string' ? frame.message : 'Terminal rejected the command.')
        return
      }
      if (frame.type === 'snapshot' && !ready) {
        if (frame.terminal_snapshot_format !== 'xterm-replay-v1') {
          fail('incompatible', 'Terminal recovery format is incompatible with this CLI.')
          return
        }
        const recovery = frame.terminal_recovery as Record<string, unknown> | undefined
        if (!recovery || !Number.isSafeInteger(recovery.through_offset) || Number(recovery.through_offset) < 0) {
          fail('protocol', 'Terminal recovery metadata is invalid.')
          return
        }
        if (recovery.complete === true) {
          if (!Array.isArray(recovery.events)) {
            fail('protocol', 'Terminal replay events are invalid.')
            return
          }
          for (const event of recovery.events as Array<Record<string, unknown>>) {
            if (event.offset !== offset) {
              fail('protocol', 'Terminal replay has a byte gap.')
              return
            }
            if (event.type === 'output' && typeof event.bytes_base64 === 'string') {
              const bytes = Buffer.from(event.bytes_base64, 'base64')
              write(bytes)
              if (settled) return
              offset += bytes.length
            } else if (event.type !== 'resize') {
              fail('protocol', 'Terminal replay contains an unknown event.')
              return
            }
          }
          if (offset !== recovery.through_offset) {
            fail('protocol', 'Terminal replay offset does not match the snapshot.')
            return
          }
        } else {
          offset = Number(recovery.through_offset)
          process.stderr.write(`${JSON.stringify({ type: 'warning', code: 'replay_limit_exceeded',
            message: 'Terminal history is incomplete; live output remains available.' })}\n`)
        }
        ready = true
        clearTimeout(timer)
        process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.on('data', input)
        process.stdout.on('resize', resize)
        process.on('SIGINT', signalHandlers.SIGINT)
        process.on('SIGTERM', signalHandlers.SIGTERM)
        process.on('SIGHUP', signalHandlers.SIGHUP)
        resize()
        return
      }
      if (frame.type === 'terminal' && ready) {
        if (frame.offset !== offset || !Array.isArray(frame.bytes) ||
          frame.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          fail('protocol', 'Terminal output has a byte gap or invalid bytes; attach again to recover.')
          return
        }
        const bytes = Buffer.from(frame.bytes as number[])
        offset += bytes.length
        write(bytes)
      }
    }, (reason) => fail('unavailable', reason))
  })
}

async function run(socketPath: string, words: string[]): Promise<DaemonResponse | Record<string, unknown>> {
  const [area, action, ...rest] = words
  if (area === 'status' && !action) return requestDaemon(socketPath, 'hello')
  if (area === 'workspace' && action === 'list') return { type: 'workspaces', workspaces: (await catalog(socketPath)).workspaces }
  if (area === 'workspace' && action === 'open') return requestDaemon(socketPath, 'workspace.open', { path: required(rest[0], 'PATH') })
  if (area === 'workspace' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'workspace rebind requires WORKSPACE_ID PATH.')
    return requestDaemon(socketPath, 'workspace.rebind', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'repository' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'repository rebind requires REPOSITORY_ID PATH.')
    return requestDaemon(socketPath, 'repository.rebind', {
      repository_id: required(rest[0], 'REPOSITORY_ID'), path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'worktree' && action === 'rebind') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree rebind requires REPOSITORY_ID PATH.')
    return requestDaemon(socketPath, 'worktree.rebind', {
      repository_id: required(rest[0], 'REPOSITORY_ID'), path: required(rest[1], 'PATH'),
    })
  }
  if (area === 'worktree' && action === 'rebind-list') {
    if (rest.length) throw new CliError('usage', 'worktree rebind-list does not accept arguments.')
    return requestDaemon(socketPath, 'worktree.rebind.list')
  }
  if (area === 'worktree' && action === 'register') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree register requires PATH.')
    return requestDaemon(socketPath, 'worktree.repository', { path: rest[0] })
  }
  if (area === 'worktree' && action === 'list') {
    if (rest.length !== 1) throw new CliError('usage', 'worktree list requires REPOSITORY_ID.')
    return requestDaemon(socketPath, 'worktree.get', { repository_id: rest[0] })
  }
  if (area === 'worktree' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'worktree operation requires REPOSITORY_ID REQUEST_ID.')
    return requestDaemon(socketPath, 'worktree.operation', {
      repository_id: required(rest[0], 'REPOSITORY_ID'), request_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'worktree' && action === 'create') {
    const { positionals, requestId } = worktreeMutationArgs(rest, 'create')
    const response = await requestDaemon(socketPath, 'worktree.switch', {
      repository_id: positionals[0], target: positionals[1], base: positionals[2],
      ...(positionals[3] ? { path: positionals[3] } : {}), create: true, request_id: requestId,
    })
    return { ...response, request_id: requestId }
  }
  if (area === 'worktree' && action === 'adopt') {
    if (rest.length !== 3) throw new CliError('usage', 'worktree adopt requires REPOSITORY_ID PATH CONFIRM_PATH.')
    return requestDaemon(socketPath, 'worktree.adopt', { repository_id: rest[0], path: rest[1], confirm_path: rest[2] })
  }
  if (area === 'worktree' && action === 'remove') {
    const { positionals, requestId } = worktreeMutationArgs(rest, 'remove')
    const response = await requestDaemon(socketPath, 'worktree.remove', {
      repository_id: positionals[0], path: positionals[1],
      delete_branch: positionals[2] ? 'merged' : 'keep', request_id: requestId,
    })
    return { ...response, request_id: requestId }
  }
  if (area === 'conversation' && action === 'list') {
    const all = (await catalog(socketPath)).conversations
    if (!Array.isArray(all)) throw new CliError('protocol', 'Daemon catalog has no conversations.')
    return { type: 'conversations', conversations: rest[0] ? all.filter((item) => item?.workspace_id === rest[0]) : all }
  }
  if (area === 'conversation' && action === 'inspect') {
    return requestDaemon(socketPath, 'conversation.get', { conversation_id: required(rest[0], 'ID') })
  }
  if (area === 'conversation' && action === 'export') {
    if (rest.length !== 2) throw new CliError('usage', 'conversation export requires ID FILE.')
    return exportConversation(socketPath, required(rest[0], 'ID'), required(rest[1], 'FILE'))
  }
  if (area === 'conversation' && action === 'create') {
    const flag = rest.indexOf('--account')
    const positionals = flag < 0 ? rest : rest.slice(0, flag)
    if (positionals.length > 3 || positionals.some((word) => word.startsWith('--')) ||
      (flag >= 0 && (flag !== rest.length - 2 || !rest[flag + 1]))) {
      throw new CliError('usage', 'conversation create accepts WORKSPACE_ID [PROVIDER] [TITLE] [--account ID].')
    }
    if (positionals[2]?.startsWith('account_') && flag < 0) {
      throw new CliError('usage', 'Use --account ID to select an account; the third positional value is a title.')
    }
    return requestDaemon(socketPath, 'conversation.create', {
      workspace_id: required(positionals[0], 'WORKSPACE_ID'), provider: positionals[1] ?? 'codex',
      title: positionals[2] ?? 'New Conversation',
      ...(flag >= 0 ? { account_id: rest[flag + 1] } : {}),
    })
  }
  if (area === 'conversation' && action === 'send') {
    if (rest.length !== 2 && (rest.length !== 4 || rest[2] !== '--request-id')) {
      throw new CliError('usage', 'conversation send requires ID TEXT [--request-id ID].')
    }
    const conversationId = required(rest[0], 'ID')
    const text = required(rest[1], 'TEXT')
    if (conversationId.startsWith('--')) {
      throw new CliError('usage', 'conversation send requires ID TEXT [--request-id ID].')
    }
    const suppliedId = rest[3]
    if (suppliedId !== undefined && (!suppliedId || suppliedId.startsWith('--') || suppliedId.length > 256)) {
      throw new CliError('usage', '--request-id requires an ID of 1 to 256 characters.')
    }
    const requestId = suppliedId ?? randomUUID()
    const response = await requestDaemon(socketPath, 'agent.send', { conversation_id: conversationId, request_id: requestId, text })
    return { ...response, request_id: requestId }
  }
  if (area === 'conversation' && (action === 'cancel' || action === 'resume')) {
    if (rest.length !== 1) throw new CliError('usage', `conversation ${action} requires ID.`)
    return requestDaemon(socketPath, `agent.${action}`, { conversation_id: required(rest[0], 'ID') })
  }
  if (area === 'conversation' && action === 'answer') {
    if (rest.length < 3 || rest.length > 4) {
      throw new CliError('usage', 'conversation answer requires ID REQUEST_ID DECISION [ANSWERS_JSON].')
    }
    const [conversationId, requestId, decision, answerJson] = rest
    if (!['accept', 'decline', 'cancel', 'answer'].includes(decision)) {
      throw new CliError('usage', 'DECISION must be accept, decline, cancel, or answer.')
    }
    if ((decision === 'answer') !== (answerJson !== undefined)) {
      throw new CliError('usage', 'ANSWERS_JSON is required only for the answer decision.')
    }
    const answers = answerJson === undefined ? undefined : jsonObject(answerJson, 'ANSWERS_JSON')
    if (answers && Object.values(answers).some((value) =>
      typeof value !== 'string' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string')))) {
      throw new CliError('usage', 'ANSWERS_JSON values must be text or arrays of text.')
    }
    return requestDaemon(socketPath, 'agent.answer', {
      conversation_id: required(conversationId, 'ID'),
      request_id: required(requestId, 'REQUEST_ID'), decision,
      ...(answers === undefined ? {} : { answers }),
    })
  }
  if (area === 'account' && action === 'list') {
    if (rest.length) throw new CliError('usage', 'account list does not accept arguments.')
    return requestDaemon(socketPath, 'account.list')
  }
  if (area === 'account' && action === 'create') {
    if (rest.length !== 2) throw new CliError('usage', 'account create requires PROVIDER NAME.')
    return requestDaemon(socketPath, 'account.create', {
      provider: required(rest[0], 'PROVIDER'), name: required(rest[1], 'NAME'),
    })
  }
  if (area === 'account' && (action === 'inspect' || action === 'verify' || action === 'disable')) {
    const count = action === 'verify' ? 3 : 1
    if (rest.length !== count) throw new CliError('usage', `account ${action} requires ${action === 'verify' ? 'ID EXPECTED_GENERATION IDENTITY_JSON' : 'ID'}.`)
    return requestDaemon(socketPath, `account.${action}`, {
      account_id: required(rest[0], 'ID'),
      ...(action === 'verify' ? { expected_generation: generation(rest[1]),
        expected_identity: jsonObject(rest[2], 'IDENTITY_JSON') } : {}),
    })
  }
  if (area === 'terminal' && action === 'list') {
    if (rest.length) throw new CliError('usage', 'terminal list does not accept arguments.')
    const all = (await catalog(socketPath)).workspaces
    if (!Array.isArray(all)) throw new CliError('protocol', 'Daemon catalog has no workspaces.')
    return { type: 'terminals', terminals: all.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const ids = [item.terminal_id, ...(Array.isArray(item.extra_terminals) ? item.extra_terminals : [])]
      return ids.map((terminalId) => ({ workspace_id: item.id, terminal_id: terminalId }))
    }) }
  }
  if (area === 'terminal' && action === 'create') {
    if (rest.length !== 3 || rest[1] !== '--request-id' || !rest[2] ||
      rest[2].startsWith('--') || rest[2].length > 256) {
      throw new CliError('usage', 'terminal create requires WORKSPACE_ID --request-id ID.')
    }
    const response = await requestDaemon(socketPath, 'terminal.create', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), request_id: rest[2],
    })
    return { ...response, request_id: rest[2] }
  }
  if (area === 'terminal' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'terminal operation requires WORKSPACE_ID REQUEST_ID.')
    return requestDaemon(socketPath, 'terminal.operation', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), request_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'terminal' && (action === 'stop' || action === 'retire')) {
    if (rest.length !== 2) throw new CliError('usage', `terminal ${action} requires WORKSPACE_ID TERMINAL_ID.`)
    const workspaceId = required(rest[0], 'WORKSPACE_ID')
    const terminalId = required(rest[1], 'TERMINAL_ID')
    await terminalTarget(socketPath, workspaceId, terminalId)
    return requestDaemon(socketPath, `terminal.${action}`, { workspace_id: workspaceId, terminal_id: terminalId })
  }
  if (area === 'terminal' && ['inspect', 'send', 'resize'].includes(action ?? '')) {
    const workspaceId = required(rest[0], 'WORKSPACE_ID')
    const terminalId = required(rest[1], 'TERMINAL_ID')
    await terminalTarget(socketPath, workspaceId, terminalId)
    if (action === 'inspect') return terminalAction(socketPath, workspaceId, terminalId, 'inspect')
    if (action === 'send') {
      const data = required(rest[2], 'TEXT')
      if (Buffer.byteLength(data) > 64 * 1024) throw new CliError('invalid_request', 'Terminal input exceeds 64 KiB.')
      const result = await terminalAction(socketPath, workspaceId, terminalId, 'send', data)
      return { type: 'terminal_input_submitted', workspace_id: workspaceId, terminal_id: terminalId, metrics: result.metrics }
    }
    const cols = integer(rest[2], 'COLS')
    const rows = integer(rest[3], 'ROWS')
    const result = await terminalAction(socketPath, workspaceId, terminalId, 'resize', undefined, { cols, rows })
    return { type: 'terminal_resize_submitted', workspace_id: workspaceId, terminal_id: terminalId, cols, rows, metrics: result.metrics }
  }
  if (area === 'browser' && action === 'owner') {
    if (rest.length) throw new CliError('usage', 'browser owner does not accept arguments.')
    return requestDaemon(socketPath, 'browser.owner.get')
  }
  if (area === 'browser' && (action === 'list' || action === 'inspect')) {
    const count = action === 'inspect' ? 2 : 1
    if (rest.length !== count) throw new CliError('usage', `browser ${action} requires OWNER_ID${count === 2 ? ' TAB_ID' : ''}.`)
    const owner = await requestDaemon(socketPath, 'browser.owner.get')
    const profileId = owner.profile_id
    if (typeof profileId !== 'string' || !profileId) throw new CliError('protocol', 'Browser owner has no profile identity.')
    return requestDaemon(socketPath, `browser.${action}`, {
      profile_id: profileId, owner_id: required(rest[0], 'OWNER_ID'),
      ...(action === 'inspect' ? { tab_id: required(rest[1], 'TAB_ID') } : {}),
    })
  }
  if (area === 'browser' && action === 'operation') {
    if (rest.length !== 1) throw new CliError('usage', 'browser operation requires REQUEST_ID.')
    return requestDaemon(socketPath, 'browser.operation', { request_id: required(rest[0], 'REQUEST_ID') })
  }
  if (area === 'browser' && (action === 'open' || action === 'navigate' || action === 'close')) {
    const positionalCount = action === 'open' ? 2 : action === 'navigate' ? 3 : 2
    if (rest.length !== positionalCount + 2 || rest[positionalCount] !== '--request-id' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(rest[positionalCount + 1] ?? '')) {
      throw new CliError('usage', `browser ${action} requires OWNER_ID${action === 'open' ? ' URL' :
        action === 'navigate' ? ' TAB_ID URL' : ' TAB_ID'} --request-id ID.`)
    }
    const owner = await requestDaemon(socketPath, 'browser.owner.get')
    const profileId = owner.profile_id
    if (typeof profileId !== 'string' || !profileId) throw new CliError('protocol', 'Browser owner has no profile identity.')
    return requestDaemon(socketPath, `browser.${action}`, {
      profile_id: profileId, owner_id: required(rest[0], 'OWNER_ID'),
      request_id: rest[positionalCount + 1],
      ...(action !== 'open' ? { tab_id: required(rest[1], 'TAB_ID') } : {}),
      ...(action !== 'close' ? { url: required(rest[action === 'open' ? 1 : 2], 'URL') } : {}),
    })
  }
  if (area === 'service' && action === 'list') {
    return requestDaemon(socketPath, 'service.list', { workspace_id: required(rest[0], 'WORKSPACE_ID') })
  }
  if (area === 'service' && action === 'inspect') {
    if (rest.length > 3) throw new CliError('usage', 'service inspect accepts WORKSPACE_ID NAME [TAIL_BYTES].')
    return requestDaemon(socketPath, 'service.inspect', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      tail_bytes: tailBytes(rest[2]),
    })
  }
  if (area === 'service' && action === 'url') {
    if (rest.length !== 3) throw new CliError('usage', 'service url requires WORKSPACE_ID NAME PORT_VARIABLE.')
    return requestDaemon(socketPath, 'service.proxy.ensure', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
    })
  }
  if (area === 'service' && action === 'url-inspect') {
    if (rest.length !== 3) throw new CliError('usage', 'service url-inspect requires WORKSPACE_ID NAME PORT_VARIABLE.')
    return requestDaemon(socketPath, 'service.proxy.inspect', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
    })
  }
  if (area === 'service' && action === 'remap') {
    if (rest.length !== 7) throw new CliError('usage',
      'service remap requires WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_ROUTE_ID EXPECTED_ROUTE_PORT.')
    return requestDaemon(socketPath, 'service.proxy.remap', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
      expected_service_identity: required(rest[3], 'EXPECTED_SERVICE_ID'),
      expected_target_port: port(rest[4], 'EXPECTED_TARGET_PORT'),
      expected_route_identity: required(rest[5], 'EXPECTED_ROUTE_ID'),
      expected_route_port: port(rest[6], 'EXPECTED_ROUTE_PORT'),
    })
  }
  if (area === 'service' && action === 'url-retire') {
    if (rest.length !== 7) throw new CliError('usage',
      'service url-retire requires WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT.')
    return requestDaemon(socketPath, 'service.proxy.retire', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
      expected_route_id: required(rest[3], 'EXPECTED_ROUTE_ID'),
      expected_service_identity: required(rest[4], 'EXPECTED_SERVICE_ID'),
      expected_target_port: port(rest[5], 'EXPECTED_TARGET_PORT'),
      expected_proxy_port: port(rest[6], 'EXPECTED_PROXY_PORT'),
    })
  }
  if (area === 'service' && action === 'url-recovery') {
    if (rest.length) throw new CliError('usage', 'service url-recovery does not accept arguments.')
    return requestDaemon(socketPath, 'service.proxy.recovery.inspect')
  }
  if (area === 'service' && action === 'url-retry') {
    if (rest.length !== 7) throw new CliError('usage',
      'service url-retry requires WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT.')
    return requestDaemon(socketPath, 'service.proxy.recovery.retry', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
      expected_route_id: required(rest[3], 'EXPECTED_ROUTE_ID'),
      expected_service_identity: required(rest[4], 'EXPECTED_SERVICE_ID'),
      expected_target_port: port(rest[5], 'EXPECTED_TARGET_PORT'),
      expected_proxy_port: port(rest[6], 'EXPECTED_PROXY_PORT'),
    })
  }
  if (area === 'service' && action === 'url-recovery-reset') {
    if (rest.length !== 2 || rest[1] !== '--confirm-reset') throw new CliError('usage',
      'service url-recovery-reset requires EXPECTED_REGISTRY_SHA256 --confirm-reset. Inspect first; the corrupt bytes are archived.')
    return requestDaemon(socketPath, 'service.proxy.recovery.reset', {
      expected_registry_sha256: sha256(rest[0]),
    })
  }
  if (area === 'service' && action === 'configure') {
    return requestDaemon(socketPath, 'service.configure', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      config: jsonObject(rest[2], 'JSON_CONFIG'), revision: revision(rest[3]),
    })
  }
  if (area === 'service' && (action === 'start' || action === 'stop')) {
    return requestDaemon(socketPath, `service.${action}`, {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
    })
  }
  if (area === 'script' && (action === 'list' || action === 'runs')) {
    if (rest.length !== 1) throw new CliError('usage', `script ${action} requires WORKSPACE_ID.`)
    return requestDaemon(socketPath, `script.${action}`, { workspace_id: required(rest[0], 'WORKSPACE_ID') })
  }
  if (area === 'script' && action === 'start') {
    if (rest.length !== 2) throw new CliError('usage', 'script start requires WORKSPACE_ID NAME.')
    return requestDaemon(socketPath, 'script.start', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
    })
  }
  if (area === 'script' && action === 'inspect') {
    if (rest.length < 2 || rest.length > 3) {
      throw new CliError('usage', 'script inspect requires WORKSPACE_ID RUN_ID [TAIL_BYTES].')
    }
    return requestDaemon(socketPath, 'script.inspect', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), run_id: required(rest[1], 'RUN_ID'),
      ...(rest[2] === undefined ? {} : { tail_bytes: tailBytes(rest[2]) }),
    })
  }
  if (area === 'script' && (action === 'stop' || action === 'retire')) {
    if (rest.length !== 2) throw new CliError('usage', `script ${action} requires WORKSPACE_ID RUN_ID.`)
    return requestDaemon(socketPath, `script.${action}`, {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), run_id: required(rest[1], 'RUN_ID'),
    })
  }
  if (area === 'git' && action === 'status') {
    if (rest.length !== 1) throw new CliError('usage', 'git status requires WORKSPACE_ID.')
    return requestDaemon(socketPath, 'review.status', { workspace_id: required(rest[0], 'WORKSPACE_ID'), force: true })
  }
  if (area === 'git' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'git operation requires WORKSPACE_ID REQUEST_ID.')
    return requestDaemon(socketPath, 'review.operation', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), request_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'git' && action === 'diff') {
    if (rest.length < 2 || rest.length > 3 || (rest.length === 3 && rest[2] !== '--staged')) {
      throw new CliError('usage', 'git diff requires WORKSPACE_ID PATH [--staged].')
    }
    return requestDaemon(socketPath, 'review.diff', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), path: required(rest[1], 'PATH'),
      staged: rest[2] === '--staged',
    })
  }
  if (area === 'git' && action === 'diff-page') {
    if (rest.length < 3 || !['staged', 'unstaged'].includes(rest[2])) {
      throw new CliError('usage', 'git diff-page requires WORKSPACE_ID PATH SIDE [--cursor CURSOR --expected-token TOKEN].')
    }
    const options = namedOptions(rest.slice(3), ['--cursor', '--expected-token'], 'git diff-page')
    if ((options['--cursor'] === undefined) !== (options['--expected-token'] === undefined)) {
      throw new CliError('usage', 'A continued diff page requires both --cursor and --expected-token.')
    }
    return requestDaemon(socketPath, 'review.diff_page', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), path: required(rest[1], 'PATH'),
      staged: rest[2] === 'staged',
      ...(options['--cursor'] === undefined ? {} : {
        cursor: options['--cursor'], expected_token: options['--expected-token'],
      }),
    })
  }
  if (area === 'git' && action === 'feedback-search') {
    if (rest.length < 1) throw new CliError('usage', 'git feedback-search requires WORKSPACE_ID and --path or --query.')
    const options = namedOptions(rest.slice(1), ['--path', '--query', '--limit', '--before'], 'git feedback-search')
    if (options['--path'] === undefined && options['--query'] === undefined) {
      throw new CliError('usage', 'git feedback-search requires --path or --query.')
    }
    if (options['--query'] !== undefined && !options['--query'].trim()) {
      throw new CliError('usage', 'QUERY cannot be blank.')
    }
    return requestDaemon(socketPath, 'review.feedback.search', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'),
      ...(options['--path'] === undefined ? {} : { path: options['--path'] }),
      ...(options['--query'] === undefined ? {} : { query: options['--query'] }),
      ...(options['--limit'] === undefined ? {} : { limit: reviewSearchLimit(options['--limit']) }),
      ...(options['--before'] === undefined ? {} : { before: reviewSearchCursor(options['--before']) }),
    })
  }
  if (area === 'git' && action === 'feedback-send') {
    if (rest.length !== 3 || !rest[1] || rest[1].length > 256) {
      throw new CliError('usage', 'git feedback-send requires CONVERSATION_ID REQUEST_ID FEEDBACK_JSON.')
    }
    const feedback = reviewFeedback(rest[2])
    const requestId = required(rest[1], 'REQUEST_ID')
    return sendReviewFeedback(socketPath, required(rest[0], 'CONVERSATION_ID'), requestId, feedback)
  }
  if (area === 'git' && (action === 'stage' || action === 'unstage' || action === 'commit' || action === 'discard')) {
    const { workspaceId, value, token, requestId, diffToken } = gitMutationArgs(rest, action)
    const fields = action === 'commit'
      ? { message: value, index_token: token }
      : { path: value, revision: token, ...(action === 'discard' ? { diff_token: diffToken } : {}) }
    const response = await requestDaemon(socketPath, `review.${action}`, {
      workspace_id: workspaceId, request_id: requestId, ...fields,
    })
    return { ...response, workspace_id: workspaceId, request_id: requestId }
  }
  if (area === 'listener' && action === 'list') {
    if (rest.length) throw new CliError('usage', 'listener list does not accept arguments.')
    return requestDaemon(socketPath, 'listener.list')
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
      usage: 2, invalid_request: 2, unavailable: 3, incompatible: 4, timeout: 5, protocol: 6, daemon: 7,
    }
    process.stderr.write(`${JSON.stringify({ type: 'error', code, message })}\n`)
    process.exitCode = exitCodes[code as ErrorCode] ?? 6
  }
}

void main()
