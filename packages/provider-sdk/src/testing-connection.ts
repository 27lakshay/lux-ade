// One worker process under conformance test: it writes requests, reads newline-delimited
// frames and checks each reply, event and frame size against the Rust-generated contract.
import {
  decodeConnected,
  decodeProviderWorkerAck,
  decodeProviderWorkerCancelResult,
  decodeProviderWorkerEventNotification,
  decodeProviderWorkerFailure,
  decodeProviderWorkerHistoryPage,
  decodeProviderWorkerInitialize,
  decodeProviderWorkerResponse,
  decodeProviderWorkerRewindResult,
  decodeProviderWorkerSendResult,
  decodeResponse,
} from '@ade/contracts'
import type { Event as ProviderEvent, ProviderWorkerFailure } from '@ade/contracts'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { MAX_OUTPUT_FRAME_BYTES } from './provider.js'

export type Reply =
  | { readonly kind: 'result'; readonly result: unknown; readonly seq: number }
  | {
      readonly kind: 'error'
      readonly code: number
      readonly failure: ProviderWorkerFailure | null
      readonly seq: number
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'exited' }

export type ObservedEvent = { readonly seq: number; readonly event: ProviderEvent }
export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

export type LaunchSpec = {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
}

const MAX_VIOLATIONS = 64
const MAX_STDERR = 8 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Validates a result against the contract for the method that requested it. */
function decodeResult(method: string, result: unknown): void {
  switch (method) {
    case 'initialize':
      decodeProviderWorkerInitialize(result)
      return
    case 'open':
      decodeConnected(result)
      return
    case 'send':
    case 'steer':
      decodeProviderWorkerSendResult(result)
      return
    case 'history':
      decodeProviderWorkerHistoryPage(result)
      return
    case 'rewind':
      decodeProviderWorkerRewindResult(result)
      return
    case 'cancel':
      decodeProviderWorkerCancelResult(result)
      return
    case 'answer':
    case 'compact':
    case 'configure_mcp':
      decodeProviderWorkerAck(result)
      return
    case 'child_transcript':
      decodeResponse('agent.child_transcript', result)
      return
    default:
      // Methods outside the protocol have no result contract; their reply is a refusal.
      throw new Error(`a success result for a method outside the protocol (${method})`)
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class WorkerConnection {
  readonly violations: string[] = []
  readonly events: ObservedEvent[] = []
  /** Whether stdin was closed; replies after it are shutdown replies. */
  inputClosed = false
  exit: Exit | undefined
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { method: string; settle: (reply: Reply) => void }>()
  private readonly answered = new Map<number, string>()
  private readonly waiters = new Set<() => void>()
  private readonly exited: Promise<Exit>
  private nextId = 1
  /** IDs of requests written raw, outside `start`, and the replies they got. */
  private readonly raw = new Set<string | number>()
  readonly rawReplies: { readonly id: string | number; readonly refused: boolean }[] = []
  private uncorrelated = 0
  private seq = 0
  private stderrText = ''
  private buffered: Buffer = Buffer.alloc(0)
  private outputLimit = MAX_OUTPUT_FRAME_BYTES

  constructor(
    readonly label: string,
    launch: LaunchSpec,
  ) {
    this.child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // A worker may exit while a large frame is still being written; the exit is the evidence.
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString('utf8')).slice(-MAX_STDERR)
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    this.exited = new Promise((resolve) => {
      this.child.once('error', (error) => {
        this.violation(`could not start the worker: ${error.message}`)
        this.exit = { code: null, signal: null }
        this.wake()
        resolve(this.exit)
      })
      this.child.once('close', (code, signal) => {
        if (this.buffered.length > 0) this.violation('the worker ended with a partial frame on stdout')
        this.exit = { code, signal }
        for (const [, entry] of this.pending) entry.settle({ kind: 'exited' })
        this.pending.clear()
        this.wake()
        resolve(this.exit)
      })
    })
  }

  /** The exit, read fresh: it changes while the harness awaits. */
  exitStatus(): Exit | undefined {
    return this.exit
  }

  stderr(): string {
    return this.stderrText.trim()
  }

  /** Output frames above this many bytes break the descriptor's declared limit. */
  limitOutput(bytes: number): void {
    this.outputLimit = Math.min(MAX_OUTPUT_FRAME_BYTES, bytes)
  }

  get frameCount(): number {
    return this.seq
  }

  private violation(message: string): void {
    if (this.violations.length < MAX_VIOLATIONS) this.violations.push(`${this.label}: ${message}`)
  }

  private wake(): void {
    // A waiter removes itself; deleting the current entry is safe while iterating a Set.
    for (const waiter of this.waiters) waiter()
  }

  private read(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    for (;;) {
      const newline = this.buffered.indexOf(10)
      if (newline < 0) break
      const frame = this.buffered.subarray(0, newline)
      this.buffered = this.buffered.subarray(newline + 1)
      this.frame(frame)
    }
    if (this.buffered.length > this.outputLimit)
      this.violation(`a partial output frame exceeded the ${this.outputLimit}-byte limit`)
  }

  private frame(bytes: Buffer): void {
    const seq = ++this.seq
    if (bytes.length + 1 > this.outputLimit)
      this.violation(`frame ${seq} is ${bytes.length + 1} bytes; the declared output limit is ${this.outputLimit}`)
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      this.violation(`frame ${seq} is not JSON`)
      return
    }
    if (isRecord(value) && value.method === 'event') {
      try {
        const notification = decodeProviderWorkerEventNotification(value)
        this.events.push({ seq, event: notification.params })
      } catch (error) {
        this.violation(`event frame ${seq} breaks the contract: ${describe(error)}`)
      }
      this.wake()
      return
    }
    let response
    try {
      response = decodeProviderWorkerResponse(value)
    } catch (error) {
      this.violation(`frame ${seq} is neither a contract response nor an event: ${describe(error)}`)
      return
    }
    const id = response.id
    if (id === null) {
      // An uncorrelated refusal of a frame the worker could not read.
      if ('error' in response) {
        this.uncorrelated++
        this.wake()
      } else this.violation(`frame ${seq} is a success result without a request ID`)
      return
    }
    if (this.raw.has(id)) {
      this.rawReplies.push({ id, refused: 'error' in response })
      this.wake()
      return
    }
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined
    if (!entry) {
      const earlier = typeof id === 'number' ? this.answered.get(id) : undefined
      this.violation(
        earlier
          ? `request ${String(id)} (${earlier}) was answered twice`
          : `frame ${seq} answers request ${JSON.stringify(id)}, which was never sent`,
      )
      return
    }
    this.pending.delete(id as number)
    this.answered.set(id as number, entry.method)
    if ('error' in response) {
      let failure: ProviderWorkerFailure | null = null
      try {
        failure = decodeProviderWorkerFailure(response.error.data)
      } catch (error) {
        this.violation(`the ${entry.method} refusal carries no typed failure: ${describe(error)}`)
      }
      entry.settle({ kind: 'error', code: response.error.code, failure, seq })
    } else {
      try {
        decodeResult(entry.method, response.result)
      } catch (error) {
        this.violation(`the ${entry.method} result breaks its contract: ${describe(error)}`)
      }
      entry.settle({ kind: 'result', result: response.result, seq })
    }
    this.wake()
  }

  /** Whether the worker answered an unreadable frame with an uncorrelated refusal. */
  uncorrelatedRefusals(): number {
    return this.uncorrelated
  }

  /** Writes one request and returns its ID with a promise for the reply. */
  start(method: string, params: unknown, timeoutMs: number): { readonly id: number; readonly reply: Promise<Reply> } {
    const id = this.nextId++
    const reply = new Promise<Reply>((resolve) => {
      if (this.exit) return resolve({ kind: 'exited' })
      const timer = setTimeout(() => {
        // A late reply after the timeout is still a reply to a sent request.
        this.pending.delete(id)
        this.answered.set(id, `${method} (after its timeout)`)
        resolve({ kind: 'timeout' })
      }, timeoutMs)
      this.pending.set(id, {
        method,
        settle: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
      })
    })
    this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return { id, reply }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<Reply> {
    return this.start(method, params, timeoutMs).reply
  }

  /** Writes a frame the harness built by hand, whose reply is recorded rather than awaited. */
  writeRaw(id: string, data: string | Buffer): void {
    this.raw.add(id)
    this.write(data)
  }

  write(data: string | Buffer): void {
    if (this.exit || this.child.stdin.destroyed) return
    this.child.stdin.write(data)
  }

  /** Resolves with the first matching event after `from`, or undefined at the deadline. */
  async waitForEvent(
    predicate: (event: ProviderEvent) => boolean,
    timeoutMs: number,
    from = 0,
  ): Promise<ObservedEvent | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.events.find((entry) => entry.seq > from && predicate(entry.event))
      if (found) return found
      const remaining = deadline - Date.now()
      if (remaining <= 0 || this.exit) return undefined
      await this.nextChange(remaining)
    }
  }

  /** Waits until a frame arrives, the worker exits or the time passes. */
  nextChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
    })
  }

  /** Ends stdin, the protocol's shutdown signal. */
  closeInput(): void {
    this.inputClosed = true
    if (!this.child.stdin.destroyed) this.child.stdin.end()
  }

  /** Waits for exit; returns undefined when the worker outlived `ms`. */
  async waitForExit(ms: number): Promise<Exit | undefined> {
    return Promise.race([this.exited, sleep(ms).then(() => undefined)])
  }

  /** Ends input, waits up to `ms`, then kills a worker that is still running. */
  async stop(ms: number): Promise<{ readonly exit: Exit; readonly killed: boolean }> {
    this.closeInput()
    const exit = await this.waitForExit(ms)
    if (exit) return { exit, killed: false }
    this.child.kill('SIGKILL')
    return { exit: await this.exited, killed: true }
  }
}
