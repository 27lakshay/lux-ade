#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
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
  conversation list [WORKSPACE_ID]      List conversations
  conversation inspect ID               Read conversation and recent messages
  conversation create WORKSPACE_ID [PROVIDER] [TITLE] [--account ID]
  conversation send ID TEXT             Send a prompt with a generated request ID
  account list                           List profile accounts
  account create PROVIDER NAME           Register a native account home
  account inspect ID                     Check current Claude readiness
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
  listener list                         Observe local TCP listeners and service assignments
  request OP [JSON_OBJECT]              Call another daemon command

All command results are JSON on stdout. Errors are JSON on stderr.
Terminal send appends Enter; use terminal attach in a later CLI slice for raw I/O.
The profile socket is always explicit. This CLI does not start a daemon. Plans for
profile discovery, remote hosts and stable public command schemas remain open.
For Claude, authenticate the returned native home with:
  CLAUDE_CONFIG_DIR=<native_home> claude auth login
Then run account inspect and account verify. ADE never receives the login token.
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
  if (area === 'conversation' && action === 'list') {
    const all = (await catalog(socketPath)).conversations
    if (!Array.isArray(all)) throw new CliError('protocol', 'Daemon catalog has no conversations.')
    return { type: 'conversations', conversations: rest[0] ? all.filter((item) => item?.workspace_id === rest[0]) : all }
  }
  if (area === 'conversation' && action === 'inspect') {
    return requestDaemon(socketPath, 'conversation.get', { conversation_id: required(rest[0], 'ID') })
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
