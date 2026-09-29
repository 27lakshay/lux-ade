// R019: many active resources stay responsive. The provisional load fixture
// of architecture section 12 runs on one profile: 10 fixture agents, 20
// terminals, 3 services, 5 browser tabs behind a scripted browser owner, a
// large searchable history (10,000 imported messages), a 5000-line diff and a
// slow feed subscriber. It runs a sustained phase, where every terminal
// streams output and every agent takes turns, then an idle phase, then a
// daemon crash under the full workload.
//
// Command admission is the client-observed wall time of ordinary commands. It
// excludes provider latency, because the fixture provider answers at once,
// and it is asserted against the provisional 250 ms p95 target. Terminal
// echo (provisional 50 ms), process-tree memory, CPU, queues and recovery time
// are recorded, not asserted: section 12 has no budget for them yet.
//
// The browser tabs are the daemon's side only: the relay, its identity checks
// and the owner socket. Rendering, and the renderer processes' memory, belong
// to Electron and are not in this headless run.
//
// This spec is heavy. Run it alone: ADE_E2E_WORKERS=1.
import { writeFile } from 'node:fs/promises'
import { cpus, loadavg, totalmem } from 'node:os'
import { createConnection, type Socket } from 'node:net'
import { waitForIdle, type ScratchProfile } from '../fixtures'
import { expect, test } from '../fixtures/performance'
import type { LatencySample } from '../fixtures/performance-recording'
import { ownerStorageProfile, startBrowserOwner, type BrowserOwner } from '../fixtures/browser-owner'
import { subscribeFeed } from '../fixtures/feed'
import { AdmissionClient, startWorkload, summarize, terminalEcho, timed, type Workload } from '../fixtures/load'
import { claudeRecords, claudeTranscript } from '../fixtures/native-sessions'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'

const ADMISSION_TARGET_MS = 250
const ECHO_TARGET_MS = 50
const TABS = 5
const STREAMED_LINES = 20_000
const HISTORY_SESSIONS = 20
const HISTORY_MESSAGES_PER_SESSION = 500

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

/** A raw feed subscriber that reads its first frame and then never reads again. */
function stalledSubscriber(socketPath: string): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = createConnection(socketPath)
    socket.once('error', rejectSocket)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ op: 'session.subscribe' })}\n`)
      socket.once('data', () => {
        socket.pause()
        resolveSocket(socket)
      })
    })
  })
}

/**
 * Wait for `pattern` in a terminal's output on its original attachment. The
 * runtime never closes an attachment that falls behind: it resynchronizes it
 * from a fresh snapshot, so the attachment must still be open when the
 * pattern arrives.
 */
async function waitOnAttachment(stream: TerminalStream, pattern: RegExp): Promise<void> {
  await stream.waitForText(pattern, 300_000)
  expect(stream.closed, `terminal ${stream.terminalId} attachment closed`).toBe(false)
}

/** A scripted owner with five open tabs, answering the way the Electron owner does. */
async function browserWithTabs(profile: ScratchProfile): Promise<BrowserOwner> {
  const tabIds = Array.from({ length: TABS }, (_, index) => `tab-${index + 1}`)
  const tab = (storage: string, id: string) => ({
    id,
    profileId: storage,
    requestedUrl: `https://example.invalid/${id}`,
    observedUrl: `https://example.invalid/${id}`,
    title: `Load page ${id}`,
    loading: false,
    error: '',
  })
  return startBrowserOwner(profile, (command) => {
    const identity = { profile_id: command.profile_id, owner_id: command.owner_id }
    const storage = ownerStorageProfile(String(command.profile_id))
    if (command.op === 'browser.list') {
      return {
        type: 'browser_tabs',
        ...identity,
        profileId: storage,
        selectedId: tabIds[0],
        tabs: tabIds.map((id) => tab(storage, id)),
      }
    }
    return { type: 'browser_tab', ...identity, tab_id: command.tab_id, tab: tab(storage, String(command.tab_id)) }
  })
}

/**
 * Import `HISTORY_SESSIONS` native Claude Code sessions of
 * `HISTORY_MESSAGES_PER_SESSION` messages each, then wait until the search
 * index has caught up. Every message names a topic, so a search matches a
 * known share of the history.
 */
async function largeHistory(
  profile: ScratchProfile,
  workspaceId: string,
  cwd: string,
  record: (sample: LatencySample) => void,
) {
  const sessions = Array.from(
    { length: HISTORY_SESSIONS },
    (_, index) => `5e55${String(index).padStart(4, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
  )
  for (const [index, id] of sessions.entries()) {
    const turns = Array.from({ length: HISTORY_MESSAGES_PER_SESSION }, (_, message) => ({
      uuid: `m${message}`,
      parent: message === 0 ? null : `m${message - 1}`,
      role: message % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `session ${index} message ${message} discusses the pangolin ledger topic${message % 50} in detail`,
    }))
    await claudeTranscript(profile.home, id, cwd, claudeRecords(id, cwd, turns))
  }
  const imported = await timed(
    async () => {
      for (const id of sessions) {
        const reply = await call(profile, 'history.import.session', {
          provider: 'claude',
          native_session_id: id,
          workspace_id: workspaceId,
        })
        expect(reply).toMatchObject({ outcome: 'imported', added_messages: HISTORY_MESSAGES_PER_SESSION })
      }
    },
    record,
    'history.import',
  )
  const indexed = await timed(
    () =>
      expect
        .poll(async () => (await call(profile, 'history.index.status', {})).index.caught_up, { timeout: 120_000 })
        .toBe(true),
    record,
    'history.index',
  )
  return {
    messages: HISTORY_SESSIONS * HISTORY_MESSAGES_PER_SESSION,
    import_ms: Math.round(imported.ms),
    index_catch_up_ms: Math.round(indexed.ms),
  }
}

let drafts = 0

/**
 * One round of ordinary commands across the workload, timed at admission: a
 * draft save, a turn and a catalogue read per agent, a history search, and a
 * browser listing plus an inspect of every tab.
 */
async function commandRound(
  profile: ScratchProfile,
  client: AdmissionClient,
  workload: Workload,
  owner: BrowserOwner,
  round: number,
) {
  const samples: Record<string, number[]> = {
    'draft.save': [],
    'agent.send': [],
    'catalog.get': [],
    'history.search': [],
    'browser.list': [],
    'browser.inspect': [],
  }
  const browser = { profile_id: owner.profileId, owner_id: owner.ownerId }
  await Promise.all([
    ...workload.conversations.map(async (conversationId) => {
      samples['draft.save'].push(
        (
          await client.time('draft.save', {
            conversation_id: conversationId,
            window_id: 'load-window',
            revision: ++drafts,
            text: `draft ${round}`,
            attachments: [],
          })
        ).ms,
      )
      samples['agent.send'].push(
        (
          await client.time('agent.send', {
            conversation_id: conversationId,
            request_id: `load-${round}-${conversationId}`,
            text: 'hello',
          })
        ).ms,
      )
      samples['catalog.get'].push((await client.time('catalog.get', {})).ms)
    }),
    (async () => {
      const search = await client.time('history.search', { query: `pangolin topic${round % 50}`, limit: 50 })
      expect(search.value.results.length).toBeGreaterThan(0)
      samples['history.search'].push(search.ms)
    })(),
    (async () => {
      const listed = await client.time('browser.list', browser)
      expect(listed.value.tabs).toHaveLength(TABS)
      samples['browser.list'].push(listed.ms)
      await Promise.all(
        Array.from({ length: TABS }, async (_, index) => {
          const inspected = await client.time('browser.inspect', { ...browser, tab_id: `tab-${index + 1}` })
          expect(inspected.value.tab_id).toBe(`tab-${index + 1}`)
          samples['browser.inspect'].push(inspected.ms)
        }),
      )
    })(),
  ])
  await Promise.all(workload.conversations.map((conversationId) => waitForIdle(profile, conversationId, 60_000)))
  return samples
}

function merge(target: Record<string, number[]>, source: Record<string, number[]>) {
  for (const [name, values] of Object.entries(source)) (target[name] ??= []).push(...values)
}

test('ten agents, twenty terminals, three services, five browser tabs and a large history stay responsive through sustained, idle and crash phases @load', async ({
  ade,
  measurements,
  dispose,
}, testInfo) => {
  test.setTimeout(600_000)
  let phase = 'setup'
  const record = (sample: LatencySample) => measurements.record({ ...sample, name: `${phase}.${sample.name}` })
  const diagnostic = process.env.ADE_PERFORMANCE_DIAGNOSTICS === '1'
  measurements.details.workload = {
    agents: 10,
    terminals: 20,
    services: 3,
    scriptedBrowserTabs: TABS,
    syntheticHistoryMessages: HISTORY_SESSIONS * HISTORY_MESSAGES_PER_SESSION,
    diffLines: 5000,
    streamedLines: 19 * STREAMED_LINES,
  }
  measurements.details.thresholds = {
    provisional: true,
    admissionP95Ms: ADMISSION_TARGET_MS,
    echoP95Ms: ECHO_TARGET_MS,
    echoAsserted: false,
  }
  const profile = await measurements.measure('setup.profile', () => ade.profile())
  const repo = await measurements.measure('setup.repository', () => ade.repo())
  // A large diff: 5000 changed lines in one file.
  const big = Array.from({ length: 5000 }, (_, line) => `line ${line}`).join('\n')
  await repo.commit('Add a large file', { 'big.txt': `${big}\n` })
  await repo.dirty('big.txt', `${big.replace(/line /g, 'changed line ')}\n`)

  const setup = await timed(
    () => startWorkload(profile, repo.path, { agents: 10, terminals: 20, services: 3 }),
    record,
    'workload',
  )
  const workload = setup.value
  dispose(() => workload.stop())
  expect(workload.conversations).toHaveLength(10)
  expect(workload.terminals).toHaveLength(20)
  const history = await measurements.measure('setup.history', () =>
    largeHistory(profile, workload.workspaceId, repo.path, record),
  )
  const owner = await browserWithTabs(profile)
  dispose(() => owner.close())
  const fast = await subscribeFeed(profile)
  dispose(() => fast.stop())
  await fast.connected()
  const stalled = await stalledSubscriber(profile.socket)
  dispose(() => {
    stalled.destroy()
  })
  const before = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (before) measurements.details['resources.setup'] = before.resources
  const client = AdmissionClient.start(profile, record)
  dispose(() => client.close())
  phase = 'sustained'

  // Sustained phase: nineteen terminals each stream STREAMED_LINES lines.
  // Until every stream has finished (and for at least five rounds), every
  // agent takes turns, the history is searched, the tabs are read and the
  // diff is read, while the first terminal is timed for echo.
  const [echoing, ...streaming] = workload.terminals
  for (const [index, terminal] of streaming.entries()) {
    terminal.send({
      op: 'input',
      data: `for i in $(seq 1 ${STREAMED_LINES}); do echo load-$i-abcdefghijklmnopqrstuvwxyz0123456789; done; echo done-$((${index}+7000))\n`,
    })
  }
  let streamed = false
  const streams = Promise.all(
    streaming.map((terminal, index) => waitOnAttachment(terminal, new RegExp(`done-${index + 7000}\\r?\\n`))),
  ).finally(() => {
    streamed = true
  })
  const sustained: Record<string, number[]> = {}
  const echoSustained: number[] = []
  const diffs: number[] = []
  let rounds = 0
  const sustainedPhase = await timed(() =>
    Promise.all([
      (async () => {
        for (let batch = 0; batch < 200 && (batch < 3 || !streamed); batch++) {
          echoSustained.push(...(await terminalEcho(echoing, 10, 100_000 + batch * 10, record)))
        }
      })(),
      (async () => {
        while (rounds < 5 || (!streamed && rounds < 100)) {
          rounds++
          merge(sustained, await commandRound(profile, client, workload, owner, rounds))
          const diff = await client.time('review.diff', {
            workspace_id: workload.workspaceId,
            path: 'big.txt',
            staged: false,
          })
          expect(JSON.stringify(diff.value)).toContain('changed line 4999')
          diffs.push(diff.ms)
        }
      })(),
      streams,
    ]),
  )
  await streams
  const underLoad = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (underLoad) measurements.details['resources.sustained'] = underLoad.resources

  // Idle phase: nothing streams; the same measurements again.
  phase = 'idle'
  const idle: Record<string, number[]> = {}
  const idlePhase = await timed(async () => {
    for (let round = rounds + 1; round <= rounds + 3; round++)
      merge(idle, await commandRound(profile, client, workload, owner, round))
  })
  const echoIdle = await terminalEcho(echoing, 30, 200_000, record)
  const idleStatus = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (idleStatus) measurements.details['resources.idle'] = idleStatus.resources

  // The fast feed consumer kept up; the stalled one never blocked anyone.
  expect(fast.client.getState().status).toBe('connected')
  fast.stop()
  stalled.destroy()
  // No attachment was closed for lag; any that fell behind was resynchronized.
  expect(workload.terminals.filter((terminal) => terminal.closed).map((terminal) => terminal.terminalId)).toEqual([])
  const viewerResyncs = (
    await Promise.all(
      workload.terminals.map((terminal) => terminalMetrics(profile, terminal.workspaceId, terminal.terminalId)),
    )
  ).reduce((sum, metrics) => sum + Number(metrics?.viewer_resyncs ?? 0), 0)
  for (const terminal of workload.terminals) terminal.close()

  // Crash phase: the daemon is killed under the whole workload. Recovery is
  // the time until the new daemon answers, then until its catalogue lists
  // every Conversation, a terminal answers input, every service still runs
  // and the browser tabs are relayed again.
  phase = 'recovery'
  const catalogBefore = await profile.call('catalog.get', {})
  const conversationCount = catalogBefore.catalog.conversations.length
  const killed = performance.now()
  await profile.restartDaemon('kill')
  const helloMs = performance.now() - killed
  record({ name: 'hello.ready-from-kill', ms: helloMs, status: 'passed' })
  await expect
    .poll(async () => (await profile.call('catalog.get', {})).catalog.conversations.length, { timeout: 60_000 })
    .toBe(conversationCount)
  const catalogMs = performance.now() - killed
  record({ name: 'catalog.ready-from-kill', ms: catalogMs, status: 'passed' })
  const reopened = TerminalStream.open(profile, workload.workspaceId, echoing.terminalId)
  dispose(() => reopened.close())
  await reopened.snapshot()
  const [firstEcho] = await terminalEcho(reopened, 1, 300_000, record)
  const terminalMs = performance.now() - killed
  record({ name: 'terminal.ready-from-kill', ms: terminalMs, status: 'passed' })
  reopened.close()
  // Every service kept running through the crash, observed by the new daemon.
  await expect
    .poll(
      async () => {
        const { states } = await profile.call('service.list', { workspace_id: workload.workspaceId })
        return workload.services.map((name) => states[name]?.state)
      },
      { timeout: 60_000 },
    )
    .toEqual(workload.services.map(() => 'running'))
  // A new daemon knows no owner until the owner registers again, as the
  // desktop owner does when it sees a new boot ID; nothing is substituted.
  await expect(profile.call('browser.list', { profile_id: owner.profileId, owner_id: owner.ownerId })).rejects.toThrow()
  await owner.register()
  const relayed = (await profile.call('browser.list', { profile_id: owner.profileId, owner_id: owner.ownerId })).tabs
    .length
  const recoveredMs = performance.now() - killed
  record({ name: 'all.ready-from-kill', ms: recoveredMs, status: 'passed' })
  const afterCrash = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (afterCrash) measurements.details['resources.recovery'] = afterCrash.resources
  const crashAdmission: Record<string, number[]> = {}
  merge(crashAdmission, await commandRound(profile, client, { ...workload, terminals: [] }, owner, rounds + 4))

  const admission = (phase: Record<string, number[]>) => ({
    all: summarize(Object.values(phase).flat()),
    ...Object.fromEntries(Object.entries(phase).map(([name, values]) => [name, summarize(values)])),
  })
  type Status = NonNullable<typeof idleStatus>
  const memory = (status: Status | null) =>
    status
      ? {
          observed: status.resources.observed,
          method: status.resources.method,
          total_processes: status.resources.total_processes,
          footprint_mib: Math.round((status.resources.total_footprint_bytes ?? 0) / 1024 / 1024),
          cpu_time_ms: status.resources.total_cpu_time_ms,
          load_average_milli: status.resources.host.load_average_milli,
          groups: status.resources.groups.length,
        }
      : null
  // Process-tree CPU over a phase, as a share of one core.
  const cpu = (from: Status | null, to: Status | null, wallMs: number) => {
    if (!from || !to) return null
    const used = (to.resources.total_cpu_time_ms ?? 0) - (from.resources.total_cpu_time_ms ?? 0)
    return { cpu_time_ms: used, wall_ms: Math.round(wallMs), cores: Math.round((used / wallMs) * 100) / 100 }
  }
  const queues = (status: Status | null) =>
    status?.queues.map((queue) => ({ name: queue.name, depth: queue.depth, capacity: queue.capacity }))
  const results = {
    host: {
      logical_cpus: cpus().length,
      memory_gib: Math.round(totalmem() / 1024 ** 3),
      platform: process.platform,
      arch: process.arch,
      load_average_at_end: loadavg().map((value) => Math.round(value * 10) / 10),
      e2e_workers: testInfo.config.workers,
    },
    workload: {
      agents: 10,
      terminals: 20,
      services: 3,
      browser_tabs: TABS,
      history_messages: history.messages,
      diff_lines: 5000,
      slow_subscribers: 1,
      streamed_lines: 19 * STREAMED_LINES,
      sustained_rounds: rounds,
      setup_ms: Math.round(setup.ms),
      viewer_resyncs: viewerResyncs,
    },
    history: { import_ms: history.import_ms, index_catch_up_ms: history.index_catch_up_ms },
    targets: { provisional: true, admission_p95_ms: ADMISSION_TARGET_MS, echo_p95_ms: ECHO_TARGET_MS },
    sustained: {
      admission: admission(sustained),
      echo: summarize(echoSustained),
      diff: summarize(diffs),
      cpu: cpu(before, underLoad, sustainedPhase.ms),
      memory: memory(underLoad),
      queues: queues(underLoad),
    },
    idle: {
      admission: admission(idle),
      echo: summarize(echoIdle),
      cpu: cpu(underLoad, idleStatus, idlePhase.ms),
      memory: memory(idleStatus),
      queues: queues(idleStatus),
    },
    recovery: {
      hello_ms: Math.round(helloMs),
      catalog_ms: Math.round(catalogMs),
      terminal_ms: Math.round(terminalMs),
      first_echo_ms: Math.round(firstEcho),
      all_ms: Math.round(recoveredMs),
      browser_tabs_relayed: relayed,
      admission_after: admission(crashAdmission),
      memory: memory(afterCrash),
    },
    counters: idleStatus?.counters.map((counter) => ({ name: counter.name, value: counter.value })),
  }
  measurements.details.results = results
  await testInfo.attach('load-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  })
  // `ADE_E2E_LOAD_RESULTS=<file>` keeps the measurements for the evidence record.
  if (process.env.ADE_E2E_LOAD_RESULTS)
    await writeFile(process.env.ADE_E2E_LOAD_RESULTS, `${JSON.stringify(results, null, 2)}\n`)

  // Bounded queues: no queue with a capacity is past it.
  for (const status of [underLoad, idleStatus, afterCrash]) {
    if (!status) continue
    for (const queue of status.queues) {
      if (typeof queue.capacity === 'number') expect(queue.depth, queue.name).toBeLessThanOrEqual(queue.capacity)
    }
  }
  if (diagnostic) {
    expect(underLoad?.resources.observed).toBe(true)
    expect(afterCrash?.resources.observed).toBe(true)
  }
  // The browser owner outlives the daemon, and the new daemon relays to it once it registers again.
  expect(relayed).toBe(TABS)
  // The provisional admission target holds in every phase.
  expect(results.sustained.admission.all.p95).toBeLessThan(ADMISSION_TARGET_MS)
  expect(results.idle.admission.all.p95).toBeLessThan(ADMISSION_TARGET_MS)
  expect(results.recovery.admission_after.all.p95).toBeLessThan(ADMISSION_TARGET_MS)
})
