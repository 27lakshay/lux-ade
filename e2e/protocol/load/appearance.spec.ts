import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { cpus, loadavg, totalmem } from 'node:os'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { expect, waitForIdle, type ScratchProfile } from '../fixtures'
import { test } from '../fixtures/performance'
import type { LatencySample } from '../fixtures/performance-recording'
import { ownerStorageProfile, startBrowserOwner, type BrowserOwner } from '../fixtures/browser-owner'
import { subscribeFeed } from '../fixtures/feed'
import { AdmissionClient, startWorkload, summarize, terminalEcho, timed, type Workload } from '../fixtures/load'
import { claudeRecords, claudeTranscript } from '../fixtures/native-sessions'
import { socketReply } from '../fixtures/sockets'
import { terminalMetrics, TerminalStream, type TerminalFrame } from '../fixtures/terminals'
import { openView } from '../terminals2/viewer'

const AGENTS = 10
const TERMINALS = 20
const SERVICES = 3
const TABS = 5
const STREAMED_LINES = 20_000
const HISTORY_SESSIONS = 20
const HISTORY_MESSAGES_PER_SESSION = 500
const APPEARANCE_CYCLES = 2

type LoadRecord = (sample: LatencySample) => void
type TerminalView = {
  frames: Array<{ type: string; run_id?: string; appearance?: unknown; resync?: boolean }>
  viewer: {
    screen: { snapshot(): { cols: number; rows: number; dirtyRows: ReadonlySet<number>; foreground: unknown } }
  }
}
let drafts = 0

async function stalledSubscriber(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath)
  await once(socket, 'connect')
  socket.write(JSON.stringify({ op: 'session.subscribe' }) + '\n')
  await once(socket, 'data')
  socket.pause()
  return socket
}

async function waitOnAttachment(stream: TerminalStream, pattern: RegExp): Promise<void> {
  await stream.waitForText(pattern, 300_000)
  expect(stream.closed, 'terminal ' + stream.terminalId + ' attachment closed').toBe(false)
}

function appearanceFromFrame(frame: TerminalFrame): unknown {
  if (frame.type === 'terminal_appearance' || (frame.type === 'snapshot' && frame.resync === true))
    return frame.appearance
  return undefined
}

function hasAppearanceRevision(frame: TerminalFrame, runId: string, revision: number): boolean {
  const appearance = appearanceFromFrame(frame)
  return (
    frame.run_id === runId &&
    typeof appearance === 'object' &&
    appearance !== null &&
    'revision' in appearance &&
    appearance.revision === revision
  )
}

async function browserWithTabs(profile: ScratchProfile): Promise<BrowserOwner> {
  const tabIds = Array.from({ length: TABS }, (_, index) => 'tab-' + (index + 1))
  const tab = (storage: string, id: string) => ({
    id,
    profileId: storage,
    requestedUrl: 'https://example.invalid/' + id,
    observedUrl: 'https://example.invalid/' + id,
    title: 'Load page ' + id,
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

async function largeHistory(profile: ScratchProfile, workspaceId: string, cwd: string, record: LoadRecord) {
  const sessions = Array.from(
    { length: HISTORY_SESSIONS },
    (_, index) => '5e55' + String(index).padStart(4, '0') + '-0000-4000-8000-' + String(index).padStart(12, '0'),
  )
  for (const [index, id] of sessions.entries()) {
    const turns = Array.from({ length: HISTORY_MESSAGES_PER_SESSION }, (_, message) => ({
      uuid: 'm' + message,
      parent: message === 0 ? null : 'm' + (message - 1),
      role: message % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text:
        'session ' +
        index +
        ' message ' +
        message +
        ' discusses the pangolin ledger topic' +
        (message % 50) +
        ' in detail',
    }))
    await claudeTranscript(profile.home, id, cwd, claudeRecords(id, cwd, turns))
  }
  const imported = await timed(
    async () => {
      for (const id of sessions) {
        const reply = await profile.call('history.import.session', {
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
        .poll(async () => (await profile.call('history.index.status', {})).index.caught_up, { timeout: 120_000 })
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

async function commandRound(
  profile: ScratchProfile,
  client: AdmissionClient,
  workload: Workload,
  owner: BrowserOwner,
  round: number,
  previewRequest: {
    app_dark_theme: string
    app_light_theme: string
    terminal_binding: { kind: 'follow_app' }
    syntax_binding: { kind: 'follow_app' }
  },
): Promise<Record<string, number[]>> {
  const samples: Record<string, number[]> = {
    'draft.save': [],
    'agent.send': [],
    'catalog.get': [],
    'history.search': [],
    'themes.preview': [],
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
            text: 'draft ' + round,
            attachments: [],
          })
        ).ms,
      )
      samples['agent.send'].push(
        (
          await client.time('agent.send', {
            conversation_id: conversationId,
            request_id: 'load-' + round + '-' + conversationId,
            text: 'hello',
          })
        ).ms,
      )
      samples['catalog.get'].push((await client.time('catalog.get', {})).ms)
    }),
    (async () => {
      const search = await client.time('history.search', { query: 'pangolin topic' + (round % 50), limit: 50 })
      expect(search.value.results.length).toBeGreaterThan(0)
      samples['history.search'].push(search.ms)
      const preview = await client.time('themes.preview', previewRequest)
      expect(preview.value.samples).toHaveLength(2)
      samples['themes.preview'].push(preview.ms)
    })(),
    (async () => {
      const listed = await client.time('browser.list', browser)
      expect(listed.value.tabs).toHaveLength(TABS)
      samples['browser.list'].push(listed.ms)
      await Promise.all(
        Array.from({ length: TABS }, async (_, index) => {
          const tabId = 'tab-' + (index + 1)
          const inspected = await client.time('browser.inspect', { ...browser, tab_id: tabId })
          expect(inspected.value.tab_id).toBe(tabId)
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

function summarizeAdmissions(samples: Record<string, number[]>) {
  return {
    all: summarize(Object.values(samples).flat()),
    ...Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)])),
  }
}
type TimedObservation<T> = { status: 'passed'; ms: number; value: T } | { status: 'failed'; ms: number; error: string }

function timeObservation<T>(pending: Promise<T>, started: number): Promise<TimedObservation<T>> {
  return pending.then(
    (value) => ({ status: 'passed', ms: performance.now() - started, value }),
    (error) => ({ status: 'failed', ms: performance.now() - started, error: String(error) }),
  )
}

async function switchAppearance(
  profile: ScratchProfile,
  terminals: TerminalStream[],
  targets: Array<{ workspace_id: string; terminal_id: string }>,
  runIds: string[],
  view: TerminalView,
  palette: { id: string; mode: 'dark' | 'light' },
  expectedRevision: number,
  record: LoadRecord,
  sampleIndex: number,
  outputFloodActive: boolean,
  diagnostic: boolean,
): Promise<Record<string, unknown>> {
  const desiredRevision = expectedRevision + 1
  const observerStarted = performance.now()
  const daemonConvergence = timeObservation(
    expect
      .poll(
        async () => {
          const committed = await profile.call('settings.appearance', {})
          return (
            committed.revision === desiredRevision &&
            committed.propagation.state === 'applied' &&
            committed.propagation.revision === desiredRevision
          )
        },
        { timeout: 30_000, intervals: [10, 25, 50, 100] },
      )
      .toBe(true),
    observerStarted,
  )
  const observerConvergence = terminals.map((terminal, index) => {
    const target = targets[index]!
    const runId = runIds[index]!
    let applied: { revision: number; selected_id: string; appearance: unknown } | undefined
    const runtimeConvergence = timeObservation(
      expect
        .poll(
          async () => {
            applied = await profile.call('terminal.appearance.get', target)
            return applied.revision === desiredRevision && applied.selected_id === palette.id
          },
          { timeout: 30_000, intervals: [10, 25, 50, 100] },
        )
        .toBe(true)
        .then(() => applied!),
      observerStarted,
    )
    const frameStart = terminal.frames.length
    const frameConvergence = timeObservation(
      terminal.waitFor(
        'terminal appearance state ' + palette.id + ' at revision ' + desiredRevision,
        (frame) => hasAppearanceRevision(frame, runId, desiredRevision),
        { from: frameStart, timeout: 30_000 },
      ),
      observerStarted,
    )
    return Promise.all([runtimeConvergence, frameConvergence]).then(([runtime, frame]) => ({
      terminal_id: target.terminal_id,
      revision: desiredRevision,
      selected_id: palette.id,
      run_id: runId,
      runtime,
      frame,
    }))
  })
  const viewFrameStart = view.frames.length
  const request = {
    op: 'settings.set',
    appearance: palette.mode,
    expected_appearance_revision: expectedRevision,
    ...(palette.mode === 'dark' ? { app_dark_theme: palette.id } : { app_light_theme: palette.id }),
  }
  const ackStarted = performance.now()
  const ackResult = await timeObservation(socketReply(profile.socket, request), ackStarted)
  const [daemon, observers] = await Promise.all([daemonConvergence, Promise.all(observerConvergence)])

  let ackError = ackResult.status === 'failed' ? ackResult.error : undefined
  let settings: Record<string, unknown> | undefined
  if (ackResult.status === 'passed') {
    const { frame, closed } = ackResult.value
    if (
      closed ||
      !frame ||
      frame.type !== 'settings' ||
      !('settings' in frame) ||
      !frame.settings ||
      typeof frame.settings !== 'object'
    )
      ackError = 'Raw appearance command did not return settings'
    else if (!('appearance_revision' in frame.settings) || typeof frame.settings.appearance_revision !== 'number')
      ackError = 'Raw settings acknowledgement has no appearance revision'
    else {
      settings = frame.settings
      if (settings.appearance_revision !== desiredRevision)
        ackError = 'Raw settings acknowledgement revision did not match the requested appearance revision'
    }
  }
  const failedRuntime = observers.filter((observer) => observer.runtime.status === 'failed')
  const failedFrames = observers.filter((observer) => observer.frame.status === 'failed')
  const mismatchedFrames = observers.filter(
    (observer) =>
      observer.runtime.status === 'passed' &&
      observer.frame.status === 'passed' &&
      !isDeepStrictEqual(observer.runtime.value.appearance, appearanceFromFrame(observer.frame.value)),
  )
  const daemonError = daemon.status === 'failed' ? daemon.error : undefined
  record({
    name: 'appearance.ack.' + sampleIndex,
    ms: ackResult.ms,
    status: ackError ? 'failed' : 'passed',
    ...(ackError ? { error: ackError } : {}),
  })
  record({
    name: 'appearance.daemon-convergence.' + sampleIndex,
    ms: daemon.ms,
    status: daemon.status,
    ...(daemon.status === 'failed' ? { error: daemon.error } : {}),
  })
  const runtimeMs = Math.max(...observers.map((observer) => observer.runtime.ms))
  const runtimeError = failedRuntime
    .map(
      (observer) => observer.terminal_id + ': ' + (observer.runtime.status === 'failed' ? observer.runtime.error : ''),
    )
    .join('; ')
  record({
    name: 'appearance.runtime-convergence.' + sampleIndex,
    ms: runtimeMs,
    status: runtimeError ? 'failed' : 'passed',
    ...(runtimeError ? { error: runtimeError } : {}),
  })
  const frameMs = Math.max(...observers.map((observer) => observer.frame.ms))
  const frameError = [
    ...failedFrames.map(
      (observer) => observer.terminal_id + ': ' + (observer.frame.status === 'failed' ? observer.frame.error : ''),
    ),
    ...mismatchedFrames.map(
      (observer) => observer.terminal_id + ': terminal frame did not match its resolved runtime appearance',
    ),
  ].join('; ')
  record({
    name: 'appearance.terminal-frame.' + sampleIndex,
    ms: frameMs,
    status: frameError ? 'failed' : 'passed',
    ...(frameError ? { error: frameError } : {}),
  })
  if (ackError || daemonError || runtimeError || frameError)
    throw new Error([ackError, daemonError, runtimeError, frameError].filter(Boolean).join('\n'))

  const committed = await profile.call('settings.appearance', {})
  expect(committed.revision).toBe(desiredRevision)
  expect(committed.propagation).toMatchObject({ state: 'applied', revision: desiredRevision })
  await expect
    .poll(() =>
      view.frames
        .slice(viewFrameStart)
        .some(
          (candidate) =>
            candidate.run_id === runIds[0] &&
            (candidate.type === 'terminal_appearance' ||
              (candidate.type === 'snapshot' && candidate.resync === true)) &&
            isDeepStrictEqual(candidate.appearance, committed.terminal),
        ),
    )
    .toBe(true)
  const screen = view.viewer.screen.snapshot()
  expect(screen.dirtyRows.size, palette.id + ' repaint dirty rows').toBeGreaterThan(0)
  expect(screen.foreground).toEqual(committed.terminal.foreground)
  const processResources = diagnostic ? (await profile.call('diagnostics.status', {})).resources : null
  return {
    palette: palette.id,
    mode: palette.mode,
    sample_index: sampleIndex,
    revision: settings!.appearance_revision,
    ack_ms: ackResult.ms,
    daemon_convergence_ms: daemon.ms,
    runtime_convergence_ms: runtimeMs,
    terminal_frame_ms: frameMs,
    terminal_observers: observers.map((observer) => ({
      terminal_id: observer.terminal_id,
      revision: observer.revision,
      selected_id: observer.selected_id,
      runtime_ms: observer.runtime.ms,
      frame_ms: observer.frame.ms,
      run_id: observer.run_id,
    })),
    run_id: observers[0]!.run_id,
    grid: [screen.cols, screen.rows],
    output_flood_active: outputFloodActive,
    process_resources: processResources,
  }
}

test('appearance switching: shipped palettes converge and repaint under full reference load @load', async ({
  ade,
  measurements,
  dispose,
}, testInfo) => {
  test.setTimeout(600_000)
  let phase = 'setup'
  const record: LoadRecord = (sample) => measurements.record({ ...sample, name: phase + '.' + sample.name })
  const diagnostic = process.env.ADE_PERFORMANCE_DIAGNOSTICS === '1'
  measurements.details.workload = {
    agents: AGENTS,
    terminals: TERMINALS,
    services: SERVICES,
    scriptedBrowserTabs: TABS,
    syntheticHistoryMessages: HISTORY_SESSIONS * HISTORY_MESSAGES_PER_SESSION,
    diffLines: 5000,
    streamedLines: (TERMINALS - 1) * STREAMED_LINES,
    streamConsumer:
      'same-speed terminal stream subscribers plus one session-feed subscriber that stops reading after its first frame',
    appearancePalettes: 'all entries from settings.palettes, two complete cycles',
    appearanceOperation: 'raw settings.set with expected_appearance_revision; mode-matched app palette selection',
    referenceLatency:
      'Repeated real-daemon themes.preview and history.search calls alongside existing agent/browser admission; timings end at validated protocol replies.',
    terminalInputLatency:
      'Existing terminalEcho samples time terminal input through matching shell output observed by the protocol attachment; includes shell execution and stream delivery.',
    resourceBudget:
      'No appearance-specific numeric limit asserted; diagnostic process-tree physical-footprint samples are reported without a threshold.',
  }
  const profile = await measurements.measure('setup.profile', () => ade.profile())
  const repo = await measurements.measure('setup.repository', () => ade.repo())
  const big = Array.from({ length: 5000 }, (_, line) => 'line ' + line).join('\n')
  await repo.commit('Add a large file', { 'big.txt': big + '\n' })
  await repo.dirty('big.txt', big.replace(/line /g, 'changed line ') + '\n')

  const setup = await timed(
    () =>
      startWorkload(profile, repo.path, {
        agents: AGENTS,
        terminals: TERMINALS,
        services: SERVICES,
      }),
    record,
    'workload',
  )
  const workload = setup.value
  dispose(() => workload.stop())
  expect(workload.conversations).toHaveLength(AGENTS)
  expect(workload.terminals).toHaveLength(TERMINALS)
  const history = await measurements.measure('setup.history', () =>
    largeHistory(profile, workload.workspaceId, repo.path, record),
  )
  const owner = await browserWithTabs(profile)
  dispose(() => owner.close())
  const fast = await subscribeFeed(profile)
  dispose(() => fast.stop())
  await fast.connected()
  const stalled = await stalledSubscriber(profile.socket)
  const stalledSince = performance.now()
  dispose(() => {
    stalled.destroy()
  })
  const before = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (before) measurements.details['resources.setup'] = before.resources
  const client = AdmissionClient.start(profile, record)
  dispose(() => client.close())

  const initialAppearance = await profile.call('settings.appearance', {})
  const palettes = (await profile.call('settings.palettes', {})).palettes
  expect(palettes).toHaveLength(12)
  const darkPreview = palettes.find((palette) => palette.mode === 'dark')
  const lightPreview = palettes.find((palette) => palette.mode === 'light')
  if (!darkPreview || !lightPreview)
    throw new Error('Shipped dark and light palettes are required for preview measurement')
  const previewRequest = {
    app_dark_theme: darkPreview.id,
    app_light_theme: lightPreview.id,
    terminal_binding: { kind: 'follow_app' as const },
    syntax_binding: { kind: 'follow_app' as const },
  }
  const currentPaletteIndex = palettes.findIndex((palette) => palette.id === initialAppearance.theme_id)
  if (currentPaletteIndex < 0) throw new Error('The current theme is absent from the shipped palette catalog')
  const paletteOrder = [...palettes.slice(currentPaletteIndex + 1), ...palettes.slice(0, currentPaletteIndex + 1)]
  const primary = workload.terminals[0]!
  const target = { workspace_id: workload.workspaceId, terminal_id: primary.terminalId }
  const terminalTargets = workload.terminals.map((terminal) => ({
    workspace_id: terminal.workspaceId,
    terminal_id: terminal.terminalId,
  }))
  const view = await openView(profile, workload.workspaceId, primary.terminalId)
  dispose(() => view.dispose())
  const initialScreen = view.viewer.screen.snapshot()
  const initialTerminalMetrics = await Promise.all(
    workload.terminals.map((terminal) => terminalMetrics(profile, terminal.workspaceId, terminal.terminalId)),
  )
  if (initialTerminalMetrics.some((metrics) => !metrics)) throw new Error('Initial terminal metrics are incomplete')
  const terminalRunIds = initialTerminalMetrics.map((metrics) => {
    if (!metrics) throw new Error('Initial terminal metrics are incomplete')
    return metrics.run_id
  })
  const streamingTerminals = workload.terminals.slice(1)
  const initialStreamMetrics = await Promise.all(
    streamingTerminals.map((terminal) => terminalMetrics(profile, terminal.workspaceId, terminal.terminalId)),
  )
  let outputStartedAt = 0
  let rounds = 0
  let streamed = false
  let appearanceSwitching = true
  const [echoing, ...streaming] = workload.terminals
  const sustainedAdmission: Record<string, number[]> = {}
  const echoSustained: number[] = []
  const diffs: number[] = []
  let appearanceRevision = initialAppearance.revision
  let switchCount = 0
  const appearanceSamples: Array<Record<string, unknown>> = []

  phase = 'sustained'
  for (const [index, terminal] of streaming.entries()) {
    terminal.send({
      op: 'input',
      data:
        'for i in $(seq 1 ' +
        STREAMED_LINES +
        '); do echo load-$i-abcdefghijklmnopqrstuvwxyz0123456789; done; echo done-$((' +
        (index + 7000) +
        '))\n',
    })
  }
  outputStartedAt = performance.now()
  const streams = Promise.all(
    streaming.map((terminal, index) => waitOnAttachment(terminal, new RegExp('done-' + (index + 7000) + '\\r?\\n'))),
  ).then(() => {
    streamed = true
  })
  const switchTask = (async () => {
    for (let cycle = 0; cycle < APPEARANCE_CYCLES; cycle++) {
      for (const palette of paletteOrder) {
        const sample = await switchAppearance(
          profile,
          workload.terminals,
          terminalTargets,
          terminalRunIds,
          view,
          palette,
          appearanceRevision,
          record,
          switchCount,
          !streamed,
          diagnostic,
        )
        appearanceRevision = sample.revision as number
        appearanceSamples.push(sample)
        measurements.details['appearance.switch.' + switchCount] = sample
        switchCount++
      }
    }
    appearanceSwitching = false
  })()
  const sustainedPhase = await timed(
    () =>
      Promise.all([
        (async () => {
          for (let batch = 0; batch < 200 && (batch < 3 || !streamed || appearanceSwitching); batch++)
            echoSustained.push(...(await terminalEcho(echoing, 10, 100_000 + batch * 10, record)))
        })(),
        (async () => {
          while (rounds < 5 || (!streamed && rounds < 100) || appearanceSwitching) {
            rounds++
            merge(sustainedAdmission, await commandRound(profile, client, workload, owner, rounds, previewRequest))
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
        switchTask,
      ]),
    record,
    'sustained',
  )
  await streams
  const outputDurationMs = performance.now() - outputStartedAt
  const underLoad = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (underLoad) measurements.details['resources.sustained'] = underLoad.resources

  phase = 'idle'
  const idleAdmission: Record<string, number[]> = {}
  const idlePhase = await timed(async () => {
    for (let round = rounds + 1; round <= rounds + 3; round++)
      merge(idleAdmission, await commandRound(profile, client, workload, owner, round, previewRequest))
  })
  const echoIdle = await terminalEcho(echoing, 30, 200_000, record)
  const idleStatus = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (idleStatus) measurements.details['resources.idle'] = idleStatus.resources
  expect(fast.client.getState().status).toBe('connected')
  fast.stop()
  stalled.destroy()
  const stalledDurationMs = performance.now() - stalledSince
  expect(workload.terminals.filter((terminal) => terminal.closed).map((terminal) => terminal.terminalId)).toEqual([])
  const viewerResyncs = (
    await Promise.all(
      workload.terminals.map((terminal) => terminalMetrics(profile, terminal.workspaceId, terminal.terminalId)),
    )
  ).reduce((sum, metrics) => sum + Number(metrics?.viewer_resyncs ?? 0), 0)
  const metricsBeforeRecovery = await Promise.all(
    workload.terminals.map((terminal) => terminalMetrics(profile, terminal.workspaceId, terminal.terminalId)),
  )
  for (const [index, metrics] of metricsBeforeRecovery.entries()) {
    expect(metrics).toMatchObject({
      run_id: initialTerminalMetrics[index]!.run_id,
      shell_pid: initialTerminalMetrics[index]!.shell_pid,
      shell_running: true,
    })
  }

  const screenBeforeRepaint = view.viewer.screen.snapshot()
  const viewFrameStart = view.frames.length
  const primaryMetricsBeforeRepaint = metricsBeforeRecovery[0]
  phase = 'repaint'
  const desiredPalette = palettes.find(
    (palette) => palette.mode === 'dark' && palette.id !== initialAppearance.theme_id,
  )!
  const repaint = await switchAppearance(
    profile,
    workload.terminals,
    terminalTargets,
    terminalRunIds,
    view,
    desiredPalette,
    appearanceRevision,
    record,
    switchCount,
    false,
    diagnostic,
  )
  appearanceRevision = repaint.revision as number
  appearanceSamples.push(repaint)
  expect(view.viewer.screen.snapshot().cols).toBe(screenBeforeRepaint.cols)
  expect(view.viewer.screen.snapshot().rows).toBe(screenBeforeRepaint.rows)
  expect(view.viewer.screen.snapshot().foreground).not.toEqual(screenBeforeRepaint.foreground)
  expect(view.frames.slice(viewFrameStart).filter((frame) => frame.type === 'terminal_resize')).toEqual([])
  const primaryMetricsAfterRepaint = await terminalMetrics(profile, workload.workspaceId, primary.terminalId)
  expect(primaryMetricsAfterRepaint?.terminal_bytes).toBe(primaryMetricsBeforeRepaint?.terminal_bytes)
  measurements.details['appearance.idle-repaint'] = repaint

  for (const terminal of workload.terminals) terminal.close()
  view.dispose()
  phase = 'recovery'
  const catalogBefore = await profile.call('catalog.get', {})
  const conversationCount = catalogBefore.catalog.conversations.length
  const runtimeBefore = await profile.call('runtime.status', {})
  const killed = performance.now()
  await profile.restartDaemon('kill')
  const helloMs = performance.now() - killed
  record({ name: 'hello.ready-from-kill', ms: helloMs, status: 'passed' })
  await expect
    .poll(async () => (await profile.call('catalog.get', {})).catalog.conversations.length, { timeout: 60_000 })
    .toBe(conversationCount)
  const catalogMs = performance.now() - killed
  record({ name: 'catalog.ready-from-kill', ms: catalogMs, status: 'passed' })
  const recovered = await profile.call('settings.appearance', {})
  const recoveredTerminal = await profile.call('terminal.appearance.get', target)
  expect(recovered.revision).toBe(appearanceRevision)
  expect(recovered.propagation).toEqual({ state: 'applied', revision: appearanceRevision })
  expect(recoveredTerminal.revision).toBe(appearanceRevision)
  const reopenView = await openView(profile, workload.workspaceId, primary.terminalId)
  dispose(() => reopenView.dispose())
  const snapshot = reopenView.frames.find((frame) => frame.type === 'snapshot')
  expect(snapshot?.appearance).toMatchObject({ dark: desiredPalette.mode === 'dark' })
  expect(snapshot?.appearance).toEqual(recoveredTerminal.appearance)
  const reopened = TerminalStream.open(profile, workload.workspaceId, echoing.terminalId)
  dispose(() => reopened.close())
  await reopened.snapshot()
  const [firstEcho] = await terminalEcho(reopened, 1, 300_000, record)
  const terminalMs = performance.now() - killed
  record({ name: 'terminal.ready-from-kill', ms: terminalMs, status: 'passed' })
  reopened.close()
  await expect
    .poll(
      async () => {
        const { states } = await profile.call('service.list', { workspace_id: workload.workspaceId })
        return workload.services.map((name) => states[name]?.state)
      },
      { timeout: 60_000 },
    )
    .toEqual(workload.services.map(() => 'running'))
  await expect(profile.call('browser.list', { profile_id: owner.profileId, owner_id: owner.ownerId })).rejects.toThrow()
  await owner.register()
  const relayed = (await profile.call('browser.list', { profile_id: owner.profileId, owner_id: owner.ownerId })).tabs
    .length
  const recoveredMs = performance.now() - killed
  record({ name: 'all.ready-from-kill', ms: recoveredMs, status: 'passed' })
  const afterCrash = diagnostic ? await profile.call('diagnostics.status', {}) : null
  if (afterCrash) measurements.details['resources.recovery'] = afterCrash.resources
  const crashAdmission: Record<string, number[]> = {}
  merge(
    crashAdmission,
    await commandRound(profile, client, { ...workload, terminals: [] }, owner, rounds + 4, previewRequest),
  )
  const runtimeAfter = await profile.call('runtime.status', {})
  expect(runtimeAfter.runtime_instance).toBe(runtimeBefore.runtime_instance)

  const memory = (status: typeof idleStatus) =>
    status
      ? {
          observed: status.resources.observed,
          observed_at_unix_ms: status.resources.observed_at,
          method: status.resources.method,
          total_processes: status.resources.total_processes,
          total_footprint_bytes: status.resources.total_footprint_bytes,
          groups: status.resources.groups.map((group) => ({
            kind: group.kind,
            subject: group.subject,
            root_pid: group.root_pid,
            pids: group.pids,
            footprint_bytes: group.footprint_bytes,
            provenance: group.provenance,
            note: group.note,
          })),
        }
      : null
  const cpu = (from: typeof before, to: typeof underLoad, wallMs: number) => {
    if (!from || !to) return null
    const used = (to.resources.total_cpu_time_ms ?? 0) - (from.resources.total_cpu_time_ms ?? 0)
    return { cpu_time_ms: used, wall_ms: Math.round(wallMs), cores: Math.round((used / wallMs) * 100) / 100 }
  }
  const queues = (status: typeof idleStatus) =>
    status?.queues.map((queue) => ({
      name: queue.name,
      depth: queue.depth,
      capacity: queue.capacity,
    }))
  const outputMetricsAfter = await Promise.all(
    streamingTerminals.map((terminal) => terminalMetrics(profile, terminal.workspaceId, terminal.terminalId)),
  )
  let outputBytes = 0
  for (const [index, metrics] of outputMetricsAfter.entries()) {
    const beforeBytes = initialStreamMetrics[index]?.terminal_bytes
    const afterBytes = metrics?.terminal_bytes
    if (typeof beforeBytes !== 'number' || typeof afterBytes !== 'number')
      throw new Error('Streaming terminal byte metrics are unavailable')
    outputBytes += afterBytes - beforeBytes
  }
  const switchesWithOutputFlood = appearanceSamples.filter((sample) => sample.output_flood_active).length
  expect(sustainedAdmission['themes.preview'] ?? []).toHaveLength(rounds)
  expect(sustainedAdmission['history.search'] ?? []).toHaveLength(rounds)
  expect(idleAdmission['themes.preview'] ?? []).toHaveLength(3)
  expect(idleAdmission['history.search'] ?? []).toHaveLength(3)
  expect(echoSustained.length).toBeGreaterThanOrEqual(30)
  expect(echoIdle).toHaveLength(30)
  if (diagnostic) {
    expect(appearanceSamples).toHaveLength(switchCount + 1)
    expect(
      appearanceSamples.every((sample) => (sample.process_resources as { observed?: boolean } | null)?.observed),
    ).toBe(true)
  }
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
      agents: AGENTS,
      terminals: TERMINALS,
      services: SERVICES,
      browser_tabs: TABS,
      history_messages: history.messages,
      diff_lines: 5000,
      slow_subscribers: 1,
      stalled_subscriber_ms: stalledDurationMs,
      streamed_lines: (TERMINALS - 1) * STREAMED_LINES,
      sustained_rounds: rounds,
      setup_ms: Math.round(setup.ms),
      viewer_resyncs: viewerResyncs,
      terminal_consumer_delay:
        'No per-terminal throttling; one independent session-feed consumer paused after its first frame.',
    },
    history: { import_ms: history.import_ms, index_catch_up_ms: history.index_catch_up_ms },
    output: {
      lines: (TERMINALS - 1) * STREAMED_LINES,
      bytes: outputBytes,
      elapsed_ms: outputDurationMs,
      bytes_per_second: outputBytes / (outputDurationMs / 1_000),
      throttled: false,
    },
    appearance: {
      initial_theme_id: initialAppearance.theme_id,
      switch_count: appearanceSamples.length,
      memory_snapshot_count: appearanceSamples.filter((sample) => sample.process_resources !== null).length,
      switches_with_output_flood: switchesWithOutputFlood,
      switches: appearanceSamples,
      repaint: {
        grid: [initialScreen.cols, initialScreen.rows],
        resize_events: 0,
        primary_terminal_bytes_unchanged: true,
      },
      authoritative_revision_after_recovery: recovered.revision,
      runtime_instance_before_recovery: runtimeBefore.runtime_instance,
      runtime_instance_after_recovery: runtimeAfter.runtime_instance,
    },
    admission: {
      sustained: summarizeAdmissions(sustainedAdmission),
      idle: summarizeAdmissions(idleAdmission),
      recovery: summarizeAdmissions(crashAdmission),
    },
    echo: { sustained: summarize(echoSustained), idle: summarize(echoIdle), recovery: summarize([firstEcho]) },
    terminal_input_observed_round_trip: {
      boundary:
        'terminal.send(input) through matching shell output observed by the protocol attachment; includes shell execution and stream delivery',
      sustained: summarize(echoSustained),
      idle: summarize(echoIdle),
    },
    appearance_sample_counts: {
      sustained_rounds: rounds,
      preview_sustained: sustainedAdmission['themes.preview']?.length ?? 0,
      search_sustained: sustainedAdmission['history.search']?.length ?? 0,
      preview_idle: idleAdmission['themes.preview']?.length ?? 0,
      search_idle: idleAdmission['history.search']?.length ?? 0,
      terminal_echo_sustained: echoSustained.length,
      terminal_echo_idle: echoIdle.length,
      diagnostic_process_footprint_switches: appearanceSamples.filter((sample) => sample.process_resources !== null)
        .length,
    },
    appearance_reference_latency: {
      preview: {
        sustained: summarize(sustainedAdmission['themes.preview'] ?? []),
        idle: summarize(idleAdmission['themes.preview'] ?? []),
      },
      search: {
        sustained: summarize(sustainedAdmission['history.search'] ?? []),
        idle: summarize(idleAdmission['history.search'] ?? []),
      },
      preview_sample: 'themes.preview resolves both shipped palette samples',
      boundary: 'real-daemon protocol request through validated reply; excludes Electron rendering',
    },
    diff: summarize(diffs),

    phase_durations_ms: { sustained: sustainedPhase.ms, idle: idlePhase.ms },
    cpu: { sustained: cpu(before, underLoad, sustainedPhase.ms), idle: cpu(underLoad, idleStatus, idlePhase.ms) },
    resources: {
      setup: memory(before),
      sustained: memory(underLoad),
      idle: memory(idleStatus),
      recovery: memory(afterCrash),
    },
    queues: { sustained: queues(underLoad), idle: queues(idleStatus), recovery: queues(afterCrash) },
    recovery: {
      hello_ms: helloMs,
      catalog_ms: catalogMs,
      terminal_ms: terminalMs,
      first_echo_ms: firstEcho,
      all_ms: recoveredMs,
      browser_tabs_relayed: relayed,
    },
  }
  measurements.details.results = results
  await testInfo.attach('appearance-load-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  })
  if (process.env.ADE_E2E_LOAD_RESULTS)
    await writeFile(process.env.ADE_E2E_LOAD_RESULTS, JSON.stringify(results, null, 2) + '\n')

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
  expect(relayed).toBe(TABS)
  expect(switchesWithOutputFlood).toBeGreaterThan(0)
  expect(switchCount).toBe(APPEARANCE_CYCLES * palettes.length)
})
