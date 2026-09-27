// Terminal stream helpers: one raw terminal attachment over the daemon socket,
// and terminal metrics read through runtime.status. Every wait resolves on a
// frame or a query result; none sleeps.
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { expect } from '@playwright/test'
import { binaries } from './environment'
import type { ProcessLedger } from './processes'
import type { ScratchProfile } from './profile'

export type TerminalFrame = Record<string, unknown> & { type: string }

type ClientModule = typeof import('../../../packages/client/dist/index.js')
/** The built SDK, for specs that drive its terminal connection directly. It is an ES module, so it loads dynamically. */
export function clientSdk(): Promise<ClientModule> {
  return import(pathToFileURL(binaries.client).href) as Promise<ClientModule>
}

/** Decoded bytes of an xterm-replay-v1 snapshot's output events. */
export function replayText(snapshot: TerminalFrame): string {
  const recovery = snapshot.terminal_recovery as { events?: Array<Record<string, unknown>> } | undefined
  return Buffer.concat((recovery?.events ?? [])
    .filter((event) => event.type === 'output' && typeof event.bytes_base64 === 'string')
    .map((event) => Buffer.from(event.bytes_base64 as string, 'base64'))).toString('utf8')
}

/**
 * One terminal attachment. Every request carries the workspace and terminal;
 * `send` adds nothing else, so a spec controls `run_id` and `claim` exactly.
 */
export class TerminalStream {
  readonly frames: TerminalFrame[] = []
  private buffered = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private closedReason: string | null = null
  private readonly socket: Socket

  private constructor(socketPath: string, readonly workspaceId: string, readonly terminalId: string) {
    this.socket = createConnection(socketPath)
    this.socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      for (let end = this.buffered.indexOf(10); end >= 0; end = this.buffered.indexOf(10)) {
        const line = this.buffered.subarray(0, end).toString('utf8')
        this.buffered = this.buffered.subarray(end + 1)
        try { this.frames.push(JSON.parse(line) as TerminalFrame) } catch { this.frames.push({ type: 'invalid', line }) }
      }
      this.wake()
    })
    this.socket.on('error', (error) => { this.closedReason ??= error.message; this.wake() })
    this.socket.on('close', () => { this.closedReason ??= 'closed'; this.wake() })
  }

  /**
   * Connect and send `first` (by default an xterm-replay-v1 subscribe) as the
   * first line. Pass `null` to send nothing yet.
   */
  static open(profile: ScratchProfile, workspaceId: string, terminalId: string,
    first: Record<string, unknown> | null = { op: 'subscribe', snapshot_format: 'xterm-replay-v1' }): TerminalStream {
    const stream = new TerminalStream(profile.socket, workspaceId, terminalId)
    if (first) stream.send(first)
    return stream
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  send(request: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify({ workspace_id: this.workspaceId, terminal_id: this.terminalId, ...request })}\n`)
  }

  /** Resolve with the first frame at or after `from` that matches. */
  async waitFor(what: string, match: (frame: TerminalFrame) => boolean,
    options: { from?: number; timeout?: number } = {}): Promise<TerminalFrame> {
    const deadline = Date.now() + (options.timeout ?? 15_000)
    for (;;) {
      const found = this.frames.slice(options.from ?? 0).find(match)
      if (found) return found
      if (this.closedReason !== null) throw new Error(`Terminal stream closed (${this.closedReason}) before ${what}; frames: ${this.describe()}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Timed out waiting for ${what}; frames: ${this.describe()}`)
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, remaining)
        this.waiters.push(() => { clearTimeout(timer); resolveWait() })
      })
    }
  }

  /** The subscribe snapshot. */
  snapshot(): Promise<TerminalFrame> {
    return this.waitFor('the snapshot', (frame) => frame.type === 'snapshot')
  }

  /** Output seen by this attachment: the snapshot replay plus every live output frame. */
  text(): string {
    const parts: Buffer[] = []
    for (const frame of this.frames) {
      if (frame.type === 'snapshot') parts.push(Buffer.from(replayText(frame), 'utf8'))
      if (frame.type === 'terminal' && Array.isArray(frame.bytes)) parts.push(Buffer.from(frame.bytes as number[]))
    }
    return Buffer.concat(parts).toString('utf8')
  }

  /** Wait until this attachment's output matches `pattern`, and return the match. */
  async waitForText(pattern: RegExp, timeout = 15_000): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeout
    for (;;) {
      const match = this.text().match(pattern)
      if (match) return match
      if (this.closedReason !== null) throw new Error(`Terminal stream closed (${this.closedReason}) before output matched ${pattern}; output: ${JSON.stringify(this.text().slice(-2_000))}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Timed out waiting for output ${pattern}; output: ${JSON.stringify(this.text().slice(-2_000))}`)
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, remaining)
        this.waiters.push(() => { clearTimeout(timer); resolveWait() })
      })
    }
  }

  /** Wait for the connection to close, from either end. */
  async waitForClose(timeout = 15_000): Promise<string> {
    const deadline = Date.now() + timeout
    while (this.closedReason === null) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Terminal stream stayed open; frames: ${this.describe()}`)
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, remaining)
        this.waiters.push(() => { clearTimeout(timer); resolveWait() })
      })
    }
    return this.closedReason
  }

  close(): void {
    this.socket.destroy()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  private describe(): string {
    return JSON.stringify(this.frames.slice(-8).map((frame) => frame.type === 'terminal'
      ? { type: 'terminal', offset: frame.offset, data: frame.data }
      : frame.type === 'snapshot' ? { type: 'snapshot', run_id: frame.run_id, attachment: frame.attachment } : frame))
  }
}

export type TerminalMetrics = Record<string, unknown> & {
  run_id: string
  shell_pid: number | null
  shell_running: boolean
  resize_owner: number | null
  exit_status?: Record<string, unknown>
}

/** A terminal's runtime metrics from runtime.status, or undefined when the runtime has no such terminal. */
export async function terminalMetrics(profile: ScratchProfile, workspaceId: string,
  terminalId: string): Promise<TerminalMetrics | undefined> {
  const status = await profile.call('runtime.status', {}) as unknown as { terminals: Array<{
    workspace: { id: string; terminal_id: string }; metrics: TerminalMetrics }> }
  return status.terminals.find((terminal) => terminal.workspace.id === workspaceId &&
    terminal.workspace.terminal_id === terminalId)?.metrics
}

/**
 * Wait until a stopped terminal's exit has settled: the shell is not running
 * and the runtime is no longer verifying its process tree. Returns the metrics.
 */
export async function settledExit(profile: ScratchProfile, workspaceId: string, terminalId: string,
  timeout = 20_000): Promise<TerminalMetrics> {
  let metrics: TerminalMetrics | undefined
  await expect.poll(async () => {
    metrics = await terminalMetrics(profile, workspaceId, terminalId)
    return metrics !== undefined && metrics.shell_running === false && metrics.exit_status !== undefined &&
      metrics.exit_status.verifying !== true
  }, { timeout, message: 'the terminal exit to settle' }).toBe(true)
  return metrics!
}

/** A rate limit on the PTY relay's reads, lifted when `releaseFile` exists. */
export interface TtyThrottle {
  bytesPerTick?: number
  tickMs?: number
  releaseFile?: string
}

/**
 * `ade terminal attach` under a pseudo-terminal, so the CLI sees the TTY it
 * requires. A small Python relay gives the terminal an 80x24 size, copies the
 * pipe on stdin to it and its output to stdout, and exits with the CLI's code.
 * The relay is owned by the test's ledger.
 */
export async function attachThroughTty(profile: ScratchProfile, ledger: ProcessLedger, workspaceId: string,
  terminalId: string, options: TtyThrottle = {}): Promise<{ child: ChildProcess; output: () => string; exited: Promise<number | null> }> {
  // With a throttle, the relay reads at most `bytesPerTick` from the PTY per
  // tick until `releaseFile` exists, so the CLI's TTY writes block and it
  // reads its terminal stream slower than the terminal produces output.
  const throttle = options.bytesPerTick === undefined ? 'None'
    : `(${options.bytesPerTick}, ${options.tickMs ?? 50}, ${JSON.stringify(options.releaseFile ?? '')})`
  const script = [
    'import fcntl, os, pty, select, struct, sys, termios, time',
    `throttle = ${throttle}`,
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '    os.execv(sys.argv[1], sys.argv[1:])',
    "fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))",
    'sources = [fd, 0]',
    'while True:',
    '    ready = select.select(sources, [], [])[0]',
    '    if fd in ready:',
    '        limited = throttle is not None and not os.path.exists(throttle[2])',
    '        try:',
    '            data = os.read(fd, throttle[0] if limited else 65536)',
    '        except OSError:',
    "            data = b''",
    '        if not data:',
    '            break',
    '        os.write(1, data)',
    '        if limited:',
    '            time.sleep(throttle[1] / 1000)',
    '    if 0 in ready:',
    '        data = os.read(0, 65536)',
    '        if data:',
    '            os.write(fd, data)',
    '        else:',
    '            sources.remove(0)',
    'sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))',
  ].join('\n')
  const child = spawn('python3', ['-c', script, process.execPath, binaries.cli, '--socket', profile.socket,
    'terminal', 'attach', workspaceId, terminalId], { cwd: profile.defaultWorkspaceRoot, env: profile.env,
    stdio: ['pipe', 'pipe', 'pipe'] })
  if (typeof child.pid === 'number') await ledger.own(child.pid, 'terminal attach under a pty')
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  return { child, output: () => output, exited }
}
