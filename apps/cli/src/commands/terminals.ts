import {
  call,
  dailyUseCommand,
  openTerminalConnection,
  type TerminalConnection,
  type TerminalFrame,
} from '@ade/client'
import { catalog, CliError, effectOperationId, required, type CommandResult, type ErrorCode } from '../shared.js'

export const terminalUsage = `  terminal list                         List workspace terminals
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
  terminal restart WORKSPACE_ID TERMINAL_ID
                                        Start a new shell in an exited terminal
`

function integer(value: string | undefined, label: string): number {
  const number = Number(value)
  if (!value || !Number.isInteger(number) || number < 2 || number > 1000) {
    throw new CliError('usage', `${label} must be an integer from 2 to 1000.`)
  }
  return number
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

export async function attachTerminal(socketPath: string, words: string[]): Promise<void> {
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
      // Release viewport ownership explicitly; cleanup() then has nothing to close.
      terminal?.detach()
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
      if (frame.type === 'snapshot') {
        // A snapshot after the first is a resync: this attachment fell a whole
        // budget behind, the runtime skipped the output it could not queue,
        // and live output resumes at this snapshot's offset. Reset the TTY and
        // restore from the snapshot, as a fresh attach would.
        const resync = ready
        if (frame.terminal_snapshot_format !== 'xterm-replay-v1') {
          fail('incompatible', 'Terminal recovery format is incompatible with this CLI.')
          return
        }
        const recovery = frame.terminal_recovery as Record<string, unknown> | undefined
        if (!recovery || !Number.isSafeInteger(recovery.through_offset) || Number(recovery.through_offset) < 0) {
          fail('protocol', 'Terminal recovery metadata is invalid.')
          return
        }
        if (resync) write(Buffer.from('\x1bc'))
        if (recovery.complete === true) {
          if (!Array.isArray(recovery.events)) {
            fail('protocol', 'Terminal replay events are invalid.')
            return
          }
          offset = 0
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
            ...(resync ? { resync: true } : {}),
            message: resync
              ? 'Terminal fell behind and its history is too large to restore; live output continues.'
              : 'Terminal history is incomplete; live output remains available.' })}\n`)
        }
        if (resync) return
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

export async function runTerminalCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
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
    const response = await dailyUseCommand(socketPath, {
      op: 'terminal.create', workspace_id: required(rest[0], 'WORKSPACE_ID'), operation_id: rest[2],
    })
    return { ...response, request_id: rest[2] }
  }
  if (area === 'terminal' && action === 'operation') {
    if (rest.length !== 2) throw new CliError('usage', 'terminal operation requires WORKSPACE_ID REQUEST_ID.')
    return dailyUseCommand(socketPath, {
      op: 'terminal.operation', workspace_id: required(rest[0], 'WORKSPACE_ID'),
      operation_id: required(rest[1], 'REQUEST_ID'),
    })
  }
  if (area === 'terminal' && (action === 'stop' || action === 'retire')) {
    if (rest.length !== 2) throw new CliError('usage', `terminal ${action} requires WORKSPACE_ID TERMINAL_ID.`)
    const workspaceId = required(rest[0], 'WORKSPACE_ID')
    const terminalId = required(rest[1], 'TERMINAL_ID')
    await terminalTarget(socketPath, workspaceId, terminalId)
    const op = action === 'stop' ? 'terminal.stop' : 'terminal.retire'
    return dailyUseCommand(socketPath, { op, operation_id: effectOperationId(), workspace_id: workspaceId,
      terminal_id: terminalId })
  }
  if (area === 'terminal' && action === 'restart') {
    if (rest.length !== 2) throw new CliError('usage', 'terminal restart requires WORKSPACE_ID TERMINAL_ID.')
    const workspaceId = required(rest[0], 'WORKSPACE_ID')
    const terminalId = required(rest[1], 'TERMINAL_ID')
    await terminalTarget(socketPath, workspaceId, terminalId)
    return call(socketPath, 'terminal.restart', { operation_id: effectOperationId(), workspace_id: workspaceId,
      terminal_id: terminalId })
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
  return undefined
}
