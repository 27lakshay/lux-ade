#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  DaemonRequestError,
  openTerminalConnection,
  requestDaemon,
  type DaemonResponse,
  type TerminalConnection,
  type TerminalFrame,
} from '@ade/client'

const usage = `ADE local command line

Usage: ade --socket PATH COMMAND [arguments]
       ADE_SOCKET=PATH ade COMMAND [arguments]

Commands:
  status                                Inspect the selected profile daemon
  workspace list                        List registered workspaces
  workspace open PATH                   Register a repository or folder
  workspace rebind WORKSPACE_ID PATH    Bind a restored workspace to a verified directory
  repository rebind REPOSITORY_ID PATH  Bind a restored Git repository before its workspaces
  worktree rebind-list                 List restored lifecycle repositories requiring a path
  worktree rebind REPOSITORY_ID PATH    Bind restored Worktrunk lifecycle history first
  conversation list [WORKSPACE_ID]      List conversations
  conversation inspect ID               Read conversation and recent messages
  conversation export ID FILE            Write complete readable JSON history to a new file
  conversation create WORKSPACE_ID [PROVIDER] [TITLE] [--account ID]
  conversation send ID TEXT             Send a prompt with a generated request ID
  account list                           List profile accounts
  account create PROVIDER NAME           Register a native account home
  account inspect ID                     Check current Claude, Codex or Oh My Pi readiness
  account verify ID EXPECTED_GENERATION IDENTITY_JSON
                                        Pin only the identity returned by account inspect
  account disable ID                     Disable new ADE launches; does not log out native CLI or stop running agents
  terminal list                         List workspace terminals
  terminal inspect WORKSPACE_ID TERMINAL_ID
  terminal send WORKSPACE_ID TERMINAL_ID TEXT
  terminal resize WORKSPACE_ID TERMINAL_ID COLS ROWS
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
  git stage WORKSPACE_ID PATH REVISION --request-id ID
  git unstage WORKSPACE_ID PATH REVISION --request-id ID
                                        Change exactly one reviewed file
  git commit WORKSPACE_ID MESSAGE INDEX_TOKEN --request-id ID
                                        Commit the reviewed staged index
  git operation WORKSPACE_ID REQUEST_ID  Inspect a Git operation receipt
  listener list                         Observe local TCP listeners and service assignments
  request OP [JSON_OBJECT]              Call another daemon command

All command results are JSON on stdout. Errors are JSON on stderr.
Choose and retain a unique --request-id for each Git mutation. If the reply is lost,
use git operation with that ID; retry only with the same command and arguments.
Terminal send appends Enter; use terminal attach in a later CLI slice for raw I/O.
The profile socket is always explicit. This CLI does not start a daemon. Plans for
profile discovery, remote hosts and stable public command schemas remain open.
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

function parseArgs(argv: string[]): { socketPath: string | undefined; words: string[] } {
  let socketPath: string | undefined = process.env.ADE_SOCKET
  const words: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--socket') {
      socketPath = argv[++index]
      if (!socketPath) throw new CliError('usage', '--socket requires a path.')
    } else if (word.startsWith('--socket=')) {
      socketPath = word.slice('--socket='.length)
      if (!socketPath) throw new CliError('usage', '--socket requires a path.')
    } else {
      words.push(word)
    }
  }
  return { socketPath, words }
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

function gitMutationArgs(rest: string[], action: 'stage' | 'unstage' | 'commit'): {
  workspaceId: string; value: string; token: string; requestId: string
} {
  const flag = rest.length - 2
  const positionals = rest.slice(0, flag)
  if (positionals.length !== 3 || rest[flag] !== '--request-id' ||
    !rest[flag + 1] || rest[flag + 1].length > 256) {
    throw new CliError('usage', `git ${action} requires WORKSPACE_ID ${action === 'commit' ? 'MESSAGE INDEX_TOKEN' : 'PATH REVISION'} --request-id ID.`)
  }
  return {
    workspaceId: required(positionals[0], 'WORKSPACE_ID'),
    value: required(positionals[1], action === 'commit' ? 'MESSAGE' : 'PATH'),
    token: required(positionals[2], action === 'commit' ? 'INDEX_TOKEN' : 'REVISION'),
    requestId: rest[flag + 1],
  }
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
    const conversationId = required(rest[0], 'ID')
    const text = required(rest[1], 'TEXT')
    const requestId = randomUUID()
    const response = await requestDaemon(socketPath, 'agent.send', { conversation_id: conversationId, request_id: requestId, text })
    return { ...response, request_id: requestId }
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
    const all = (await catalog(socketPath)).workspaces
    if (!Array.isArray(all)) throw new CliError('protocol', 'Daemon catalog has no workspaces.')
    return { type: 'terminals', terminals: all.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const ids = [item.terminal_id, ...(Array.isArray(item.extra_terminals) ? item.extra_terminals : [])]
      return ids.map((terminalId) => ({ workspace_id: item.id, terminal_id: terminalId }))
    }) }
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
  if (area === 'git' && (action === 'stage' || action === 'unstage' || action === 'commit')) {
    const { workspaceId, value, token, requestId } = gitMutationArgs(rest, action)
    const fields = action === 'commit'
      ? { message: value, index_token: token }
      : { path: value, revision: token }
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
    const { socketPath, words } = parseArgs(process.argv.slice(2))
    if (words.length === 0 || words[0] === '--help' || words[0] === '-h' || words[0] === 'help') {
      process.stdout.write(usage)
      return
    }
    if (!socketPath) throw new CliError('usage', 'Select a profile socket with --socket PATH or ADE_SOCKET.')
    process.stdout.write(`${JSON.stringify(await run(socketPath, words))}\n`)
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
