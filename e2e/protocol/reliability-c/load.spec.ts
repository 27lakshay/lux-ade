// R019: many active resources stay responsive. The provisional load fixture
// of architecture section 12 (10 fixture agents, 20 terminals, 3 services, a
// large diff and a slow feed subscriber) runs a sustained phase, where every
// terminal streams output and every agent takes turns, and then an idle
// phase. The spec measures command admission (client-observed wall time of
// ordinary commands, which excludes provider latency because the fixture
// provider answers at once) against the provisional 250 ms p95 target, and
// records terminal echo against the provisional 50 ms target, process-tree
// memory and queue bounds. Browser tabs are not part of this headless run.
import { writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { createConnection, type Socket } from 'node:net'
import { expect, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { startWorkload, summarize, terminalEcho, timed, type Workload } from '../fixtures/load'
import { TerminalStream } from '../fixtures/terminals'

const ADMISSION_TARGET_MS = 250
const ECHO_TARGET_MS = 50

/** A raw feed subscriber that reads its first frame and then never reads again. */
function stalledSubscriber(socketPath: string): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = createConnection(socketPath)
    socket.once('error', rejectSocket)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ op: 'session.subscribe' })}\n`)
      socket.once('data', () => { socket.pause(); resolveSocket(socket) })
    })
  })
}

/**
 * Wait for `pattern` in a terminal's output. The runtime closes an attachment
 * that falls 64 frames behind instead of stalling the PTY, and the client
 * attaches again from a snapshot, as a slow viewer does. Returns the new
 * attachments that were needed, which the caller closes.
 */
async function waitThroughEvictions(profile: ScratchProfile, stream: TerminalStream, pattern: RegExp) {
  const reattached: TerminalStream[] = []
  let current = stream
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await current.waitForText(pattern, 120_000)
      return reattached
    } catch (error) {
      if (!current.closed) throw error
      current = TerminalStream.open(profile, stream.workspaceId, stream.terminalId)
      reattached.push(current)
      await current.snapshot()
    }
  }
  throw new Error(`Terminal ${stream.terminalId} was evicted 50 times before ${pattern} arrived`)
}

let drafts = 0

/** One round of ordinary commands across the workload: a draft save and a turn per agent, timed at admission. */
async function commandRound(profile: ScratchProfile, workload: Workload, round: number) {
  const samples: Record<string, number[]> = { 'draft.save': [], 'agent.send': [], 'catalog.get': [] }
  await Promise.all(workload.conversations.map(async (conversationId) => {
    samples['draft.save'].push((await timed(() => profile.call('draft.save', { conversation_id: conversationId,
      window_id: 'load-window', revision: ++drafts, text: `draft ${round}`, attachments: [] }))).ms)
    samples['agent.send'].push((await timed(() => profile.call('agent.send', { conversation_id: conversationId,
      request_id: `load-${round}-${conversationId}`, text: 'hello' }))).ms)
    samples['catalog.get'].push((await timed(() => profile.call('catalog.get', {}))).ms)
  }))
  await Promise.all(workload.conversations.map((conversationId) => waitForIdle(profile, conversationId, 60_000)))
  return samples
}

function merge(target: Record<string, number[]>, source: Record<string, number[]>) {
  for (const [name, values] of Object.entries(source)) (target[name] ??= []).push(...values)
}

test('ten agents, twenty terminals and three services stay responsive through sustained and idle phases', async ({ profile, repo }, testInfo) => {
  test.setTimeout(300_000)
  // A large diff: 5000 changed lines in one file.
  const big = Array.from({ length: 5000 }, (_, line) => `line ${line}`).join('\n')
  await repo.commit('Add a large file', { 'big.txt': `${big}\n` })
  await repo.dirty('big.txt', `${big.replace(/line /g, 'changed line ')}\n`)

  const setup = await timed(() => startWorkload(profile, repo.path, { agents: 10, terminals: 20, services: 3 }))
  const workload = setup.value
  expect(workload.conversations).toHaveLength(10)
  expect(workload.terminals).toHaveLength(20)
  const fast = await subscribeFeed(profile)
  await fast.connected()
  const stalled = await stalledSubscriber(profile.socket)

  // Sustained phase: nineteen terminals stream 3000 lines each while every
  // agent takes turns and the first terminal is timed for echo.
  const [echoing, ...streaming] = workload.terminals
  for (const [index, terminal] of streaming.entries()) {
    terminal.send({ op: 'input', data: `for i in $(seq 1 3000); do echo load-$i-abcdefghijklmnopqrstuvwxyz0123456789; done; echo done-$((${index}+7000))\n` })
  }
  const sustained: Record<string, number[]> = {}
  const [echoSustained] = await Promise.all([
    terminalEcho(echoing, 30, 100_000),
    (async () => {
      for (let round = 1; round <= 5; round++) merge(sustained, await commandRound(profile, workload, round))
    })(),
  ])
  const diff = await timed(() => profile.call('review.diff', { workspace_id: workload.workspaceId, path: 'big.txt', staged: false }))
  expect(JSON.stringify(diff.value)).toContain('changed line 4999')
  const reattached = (await Promise.all(streaming.map((terminal, index) =>
    waitThroughEvictions(profile, terminal, new RegExp(`done-${index + 7000}\\r?\\n`))))).flat()
  const underLoad = await profile.call('diagnostics.status', {})

  // Idle phase: nothing streams; the same measurements again.
  const idle: Record<string, number[]> = {}
  for (let round = 6; round <= 8; round++) merge(idle, await commandRound(profile, workload, round))
  const echoIdle = await terminalEcho(echoing, 30, 200_000)
  const idleStatus = await profile.call('diagnostics.status', {})

  // The fast feed consumer kept up; the stalled one never blocked anyone.
  expect(fast.client.getState().status).toBe('connected')
  fast.stop()
  stalled.destroy()

  const admission = (phase: Record<string, number[]>) => ({
    all: summarize(Object.values(phase).flat()),
    ...Object.fromEntries(Object.entries(phase).map(([name, values]) => [name, summarize(values)])),
  })
  const memory = (status: typeof idleStatus) => ({
    observed: status.resources.observed, method: status.resources.method,
    total_processes: status.resources.total_processes,
    footprint_mib: Math.round((status.resources.total_footprint_bytes ?? 0) / 1024 / 1024),
    cpu_time_ms: status.resources.total_cpu_time_ms,
    load_average_milli: status.resources.host.load_average_milli,
    groups: status.resources.groups.length,
  })
  const queues = (status: typeof idleStatus) => status.queues.map((queue) => ({ name: queue.name, depth: queue.depth,
    capacity: queue.capacity }))
  const results = {
    host: { logical_cpus: cpus().length, memory_gib: Math.round(totalmem() / 1024 ** 3), platform: process.platform,
      arch: process.arch, note: 'shared with other E2E suites running at the same time' },
    workload: { agents: 10, terminals: 20, services: 3, diff_lines: 5000, slow_subscribers: 1,
      streamed_lines: 19 * 3000, setup_ms: Math.round(setup.ms), slow_attachments_evicted: reattached.length },
    targets: { admission_p95_ms: ADMISSION_TARGET_MS, echo_p95_ms: ECHO_TARGET_MS },
    sustained: { admission: admission(sustained), echo: summarize(echoSustained), diff_ms: Math.round(diff.ms),
      memory: memory(underLoad), queues: queues(underLoad) },
    idle: { admission: admission(idle), echo: summarize(echoIdle), memory: memory(idleStatus), queues: queues(idleStatus) },
    counters: idleStatus.counters.map((counter) => ({ name: counter.name, value: counter.value })),
  }
  await testInfo.attach('load-results.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  // `ADE_E2E_LOAD_RESULTS=<file>` keeps the measurements for the evidence record.
  if (process.env.ADE_E2E_LOAD_RESULTS) await writeFile(process.env.ADE_E2E_LOAD_RESULTS, `${JSON.stringify(results, null, 2)}\n`)

  // Bounded queues: no queue with a capacity is past it.
  for (const status of [underLoad, idleStatus]) {
    for (const queue of status.queues) {
      if (typeof queue.capacity === 'number') expect(queue.depth, queue.name).toBeLessThanOrEqual(queue.capacity)
    }
  }
  expect(underLoad.resources.observed).toBe(true)
  // The provisional admission target holds in both phases.
  expect(results.sustained.admission.all.p95).toBeLessThan(ADMISSION_TARGET_MS)
  expect(results.idle.admission.all.p95).toBeLessThan(ADMISSION_TARGET_MS)

  for (const stream of reattached) stream.close()
  await workload.stop()
})
