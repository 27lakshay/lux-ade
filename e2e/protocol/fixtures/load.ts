// A provisional load workload (architecture section 12): fixture agents,
// terminals and services on one profile, plus latency helpers. Agents are
// Codex mock Conversations, terminals are real shells attached over the
// protocol, and services are the node HTTP fixture. Nothing calls a model.
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { CallRequest, Operation } from '../../../packages/client/dist/index.js'
import type { Response } from '../../../packages/contracts/dist/index.js'
import { send, waitForIdle } from './conversations'
import { binaries } from './environment'
import type { ScratchProfile } from './profile'
import { turnReply } from './providers'
import { configureService, nodeService, waitForReadiness, writeServicePrograms } from './services'
import { primaryShell, TerminalStream } from './terminals'
import { expect } from '@playwright/test'

export type Workload = {
  workspaceId: string
  /** Conversations that have each finished one turn. */
  conversations: string[]
  /** One attached stream per terminal; the first is the workspace's own terminal. */
  terminals: TerminalStream[]
  services: string[]
  /** Close the streams and stop the services. */
  stop(): Promise<void>
}

export type LoadShape = { agents: number; terminals: number; services: number }

/** Start `shape` in the workspace at `workspacePath`. Every resource is ready when it resolves. */
export async function startWorkload(
  profile: ScratchProfile,
  workspacePath: string,
  shape: LoadShape,
): Promise<Workload> {
  const { workspace } = await profile.call('workspace.open', { path: workspacePath })
  const shellId = await primaryShell(profile, workspace.id)
  const conversations = await Promise.all(
    Array.from({ length: shape.agents }, async () => {
      const conversationId = (
        await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'codex' })
      ).conversation.id
      await send(profile, conversationId, 'hello')
      await expect
        .poll(
          async () =>
            (await profile.call('conversation.get', { conversation_id: conversationId })).messages.some((message) =>
              message.text?.includes(turnReply.codex),
            ),
          { timeout: 60_000 },
        )
        .toBe(true)
      await waitForIdle(profile, conversationId, 60_000)
      return conversationId
    }),
  )

  const terminalIds = [shellId]
  for (let index = 1; index < shape.terminals; index++) {
    terminalIds.push((await profile.call('terminal.create', { workspace_id: workspace.id })).terminal_id)
  }
  const terminals = terminalIds.map((terminalId) => TerminalStream.open(profile, workspace.id, terminalId))
  await Promise.all(terminals.map((terminal) => terminal.snapshot()))

  const files = await writeServicePrograms(workspacePath)
  const services = Array.from({ length: shape.services }, (_, index) => `load-${index + 1}`)
  for (const name of services) {
    await configureService(profile, workspace.id, name, nodeService(files.server))
    await profile.call('service.start', { workspace_id: workspace.id, name })
  }
  await Promise.all(services.map((name) => waitForReadiness(profile, workspace.id, name, 'tcp_listening', 60_000)))

  return {
    workspaceId: workspace.id,
    conversations,
    terminals,
    services,
    async stop() {
      for (const terminal of terminals) terminal.close()
      for (const name of services) await profile.call('service.stop', { workspace_id: workspace.id, name })
    },
  }
}

/** Run `action` and return its wall time in milliseconds with its result. */
export async function timed<T>(action: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now()
  const value = await action()
  return { ms: performance.now() - started, value }
}

export type LatencySummary = { count: number; p50: number; p95: number; max: number }

/** Nearest-rank percentiles of `samples`, rounded to 0.1 ms. */
export function summarize(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
  const round = (value: number) => Math.round(value * 10) / 10
  return { count: sorted.length, p50: round(rank(50)), p95: round(rank(95)), max: round(sorted.at(-1) ?? 0) }
}

/**
 * Time terminal echo: write a shell arithmetic expression and wait for its
 * result, which the input echo cannot contain. Returns one sample per round.
 */
export async function terminalEcho(terminal: TerminalStream, rounds: number, base: number): Promise<number[]> {
  const samples: number[] = []
  for (let round = 0; round < rounds; round++) {
    const value = base + round
    const pattern = new RegExp(`(^|\\n)${value}\\r?\\n`)
    const { ms } = await timed(async () => {
      terminal.send({ op: 'input', data: `echo $((${value - 1}+1))\n` })
      await terminal.waitForText(pattern, 30_000)
    })
    samples.push(ms)
  }
  return samples
}

type WorkerReply = { id: number; ms: number; value?: unknown; error?: string }

/**
 * Times SDK calls on a worker thread. A load spec's own thread also reads
 * every terminal flood it starts, so a call timed there would include the
 * test's own parsing time; the worker's event loop does nothing but the
 * timed calls. The calls go through the SDK's `call()` with its contract
 * checks, but are not written to the test's operations log.
 */
export class AdmissionClient {
  private next = 0
  private readonly pending = new Map<number, (reply: WorkerReply) => void>()

  private constructor(private readonly worker: Worker) {
    worker.on('message', (reply: WorkerReply) => {
      this.pending.get(reply.id)?.(reply)
      this.pending.delete(reply.id)
    })
    worker.unref()
  }

  static start(profile: ScratchProfile): AdmissionClient {
    const code = `
      const { parentPort, workerData } = require('node:worker_threads')
      const { performance } = require('node:perf_hooks')
      const sdk = import(workerData.client)
      parentPort.on('message', async ({ id, op, request }) => {
        const { call } = await sdk
        const started = performance.now()
        try {
          const value = await call(workerData.socket, op, request)
          parentPort.postMessage({ id, ms: performance.now() - started, value })
        } catch (error) {
          parentPort.postMessage({ id, ms: performance.now() - started, error: String((error && error.message) || error) })
        }
      })`
    return new AdmissionClient(
      new Worker(code, {
        eval: true,
        workerData: { client: pathToFileURL(binaries.client).href, socket: profile.socket },
      }),
    )
  }

  /** Call `op` from the worker; return its wall time there and its reply. A failed call throws. */
  async time<O extends Operation>(op: O, request: CallRequest<O>): Promise<{ ms: number; value: Response<O> }> {
    const id = ++this.next
    const reply = await new Promise<WorkerReply>((resolveReply) => {
      this.pending.set(id, resolveReply)
      this.worker.postMessage({ id, op, request })
    })
    if (reply.error !== undefined) throw new Error(`${op} failed on the admission client: ${reply.error}`)
    return { ms: reply.ms, value: reply.value as Response<O> }
  }

  async close(): Promise<void> {
    await this.worker.terminate()
  }
}
