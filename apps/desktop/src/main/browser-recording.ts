// Browser recording (F097, decision D11): screenshots, page events and redacted
// console and network entries of one exact tab, saved as a local artifact for
// a bounded window. Layout under the browser profile directory:
//
//   browser-recordings-v1/<recording_id>/manifest.json     sealed on stop
//   browser-recordings-v1/<recording_id>/frames/000001.png PNG stills
//   browser-recordings-v1/<recording_id>/page-events.jsonl one event per line
//   browser-recordings-v1/<recording_id>/diagnostics.json  console and network entries
//
// A recording is never resumed: one this owner is not running is reported
// interrupted, with counts taken from the files on disk. Nothing is published.
import type { WebContents } from 'electron'
import { lstat, mkdir, open, readdir, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { browserProfileDirectory, browserTabPage, writeDurableRecord } from './browser'
import { DIAGNOSTICS_EXCLUDED, REDACTION_POLICY, redactText, redactUrl } from './browser-diagnostics-core'
import { attachDiagnostics, releaseDiagnostics, type Collector } from './browser-diagnostics'
import { coverageGaps, emptyCounters, limitReached, RECORDING_FORMAT, RECORDING_LIMITS, recordingSpec,
  reportedState, sameSpec, validManifest, type RecordingManifest, type RecordingSpec,
  type ReportedState, type StopReason } from './browser-recording-core'

type Mark = { seq: number; retained: number; dropped: number; detachments: number }
type Live = {
  key: string; profileId: string; dir: string; manifest: RecordingManifest; contents: WebContents
  collector: Collector | null; start: { console: Mark; network: Mark } | null
  timers: NodeJS.Timeout[]; events: FileHandle | null; writes: Promise<void>; ticking: boolean
  detach: Array<() => void>; stopping: Promise<void> | null; sealError: string | null
}
const running = new Map<string, Live>()
const starting = new Set<string>()
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const keyOf = (profileId: string, recordingId: string): string => `${profileId}\u0000${recordingId}`
const holderOf = (recordingId: string): string => `recording:${recordingId}`

async function recordingsRoot(profileId: string): Promise<string> {
  const root = join(browserProfileDirectory(profileId), 'browser-recordings-v1')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('Browser recording directory is unsafe; preserve it for review')
  return root
}

async function readManifest(dir: string, recordingId: string): Promise<RecordingManifest | null> {
  let info: Awaited<ReturnType<typeof lstat>>
  try { info = await lstat(join(dir, 'manifest.json')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const exists = await lstat(dir).then(() => true, () => false)
    if (exists) throw new Error('conflict: the recording directory has no manifest; preserve it for review')
    return null
  }
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Browser recording manifest is unsafe; preserve it for review')
  let value: unknown
  try { value = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) }
  catch { throw new Error('Browser recording manifest is invalid; preserve it for review') }
  return validManifest(value, recordingId)
}

/** Counts what an interrupted recording left on disk; its manifest counts stopped at the start. */
async function diskCounters(dir: string, manifest: RecordingManifest): Promise<RecordingManifest> {
  const counters = { ...manifest.counters }
  try {
    const names = (await readdir(join(dir, 'frames'))).filter((name) => /^\d{6}\.png$/.test(name)).slice(0, 10_000)
    counters.frames = names.length
    counters.bytes = 0
    for (const name of names) counters.bytes += (await lstat(join(dir, 'frames', name))).size
  } catch { /* No frames directory: nothing was captured. */ }
  try {
    const events = await lstat(join(dir, 'page-events.jsonl'))
    if (events.isFile() && events.size <= 8 * 1024 * 1024) {
      counters.pageEvents = (await readFile(join(dir, 'page-events.jsonl'), 'utf8')).split('\n').filter(Boolean).length
      counters.bytes += events.size
    }
  } catch { /* No events file. */ }
  return { ...manifest, counters }
}

function report(manifest: RecordingManifest, state: ReportedState, dir: string): Record<string, unknown> {
  const c = manifest.counters
  return { type: 'browser_recording', recording_id: manifest.recordingId, tab_id: manifest.tabId, format: RECORDING_FORMAT,
    state, capture: manifest.capture, interval_ms: manifest.intervalMs, max_duration_ms: manifest.maxDurationMs,
    started_at_ms: manifest.startedAtMs, stopped_at_ms: manifest.stoppedAtMs, stop_reason: manifest.stopReason,
    artifact_dir: dir, frames: c.frames, frames_unavailable: c.framesUnavailable, page_events: c.pageEvents,
    console_entries: c.consoleEntries, network_entries: c.networkEntries, bytes: c.bytes,
    coverage_gaps: coverageGaps(manifest, state) }
}

function liveReport(live: Live): Record<string, unknown> {
  if (live.sealError) {
    throw new Error(`unavailable: the recording stopped but its manifest was not saved (${live.sealError}); repeat stop to retry`)
  }
  return report(live.manifest, 'recording', live.dir)
}

async function storedReport(dir: string, manifest: RecordingManifest): Promise<Record<string, unknown>> {
  const state = reportedState(manifest, false)
  return report(state === 'interrupted' ? await diskCounters(dir, manifest) : manifest, state, dir)
}

function mark(collector: Collector, kind: 'console' | 'network', seq: number): Mark {
  const buffer = collector[kind]
  return { seq, retained: buffer.items.length, dropped: buffer.dropped, detachments: collector.detachments }
}

/** Serializes one page-event write after the previous one; a failure stops the recording. */
function appendEvent(live: Live, event: Record<string, unknown>): void {
  const counters = live.manifest.counters
  if (!live.events || live.stopping) return
  if (counters.pageEvents >= RECORDING_LIMITS.maxPageEvents) { counters.pageEventsDropped += 1; return }
  counters.pageEvents += 1
  const line = `${JSON.stringify({ at_ms: Date.now(), ...event })}\n`
  const handle = live.events
  live.writes = live.writes.then(async () => {
    await handle.appendFile(line)
    counters.bytes += Buffer.byteLength(line)
  }).catch(() => { void stop(live, 'write_failed') })
}

function watchPage(live: Live): void {
  const contents = live.contents
  const on = <T extends unknown[]>(event: string, listener: (...args: T) => void): void => {
    const handler = listener as (...args: unknown[]) => void
    contents.on(event as 'did-navigate', handler)
    live.detach.push(() => { if (!contents.isDestroyed()) contents.removeListener(event as 'did-navigate', handler) })
  }
  const pageEvents = live.manifest.capture.includes('page_events')
  if (pageEvents) {
    on('did-navigate', (_event: unknown, url: string) => appendEvent(live, { kind: 'navigated', url: redactUrl(url) }))
    on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) appendEvent(live, { kind: 'navigated_in_page', url: redactUrl(url) })
    })
    on('page-title-updated', (_event: unknown, title: string) => appendEvent(live, { kind: 'title_changed',
      title: redactText(title, 256) }))
    on('did-fail-load', (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      if (isMainFrame) appendEvent(live, { kind: 'load_failed', code, error: redactText(description, 256), url: redactUrl(url) })
    })
    on('render-process-gone', (_event: unknown, details: { reason?: string }) => appendEvent(live, {
      kind: 'page_process_gone', reason: redactText(details?.reason ?? 'unknown', 64) }))
  }
  const closed = (): void => {
    if (pageEvents) appendEvent(live, { kind: 'closed' })
    void stop(live, 'target_closed')
  }
  contents.once('destroyed', closed)
  live.detach.push(() => { if (!contents.isDestroyed()) contents.removeListener('destroyed', closed) })
}

async function tick(live: Live): Promise<void> {
  const counters = live.manifest.counters
  if (live.stopping) return
  if (live.ticking || live.contents.isDestroyed()) { counters.framesUnavailable += 1; return }
  live.ticking = true
  try {
    let png: Buffer | null = null
    try {
      const image = await live.contents.capturePage()
      png = image.isEmpty() ? null : image.toPNG()
    } catch { png = null }
    if (live.stopping) return
    if (!png || png.length === 0) { counters.framesUnavailable += 1; return }
    const name = `${String(counters.frames + 1).padStart(6, '0')}.png`
    try {
      const file = await open(join(live.dir, 'frames', name), 'wx', 0o600)
      try { await file.writeFile(png) } finally { await file.close() }
    } catch { void stop(live, 'write_failed'); return }
    counters.frames += 1
    counters.bytes += png.length
  } finally { live.ticking = false }
  const reason = limitReached(counters, live.manifest, Date.now() - live.manifest.startedAtMs)
  if (reason) void stop(live, reason)
}

/** The console and network entries captured inside the window, and what was lost. */
function windowEntries(live: Live): { console: unknown[]; network: unknown[] } {
  const collector = live.collector
  const start = live.start
  if (!collector || !start) return { console: [], network: [] }
  const counters = live.manifest.counters
  const pick = (kind: 'console' | 'network'): Array<{ seq: number }> => {
    const from = start[kind]
    const buffer = collector[kind]
    // Evictions remove the oldest first: the first `retained` hit entries from
    // before the window, and the rest hit entries inside it.
    const lost = Math.max(0, buffer.dropped - from.dropped - from.retained)
    if (kind === 'console') counters.consoleEvicted = lost
    else counters.networkEvicted = lost
    return buffer.items.filter((item) => item.seq > from.seq)
  }
  const consoleItems = live.manifest.capture.includes('console') ? pick('console') : []
  const networkItems = live.manifest.capture.includes('network') ? pick('network') : []
  counters.consoleEntries = consoleItems.length
  counters.networkEntries = networkItems.length
  if (collector.detachments !== start.console.detachments || !collector.attached) {
    live.manifest.captureEnded = collector.reason ?? 'detached'
  }
  return { console: consoleItems, network: networkItems }
}

/** Seals the manifest after the capture sources are quiet. A failed seal can be retried by stop. */
async function seal(live: Live): Promise<void> {
  if (live.manifest.state !== 'stopped') throw new Error('Recording is not stopped')
  try {
    await writeDurableRecord(live.dir, 'manifest.json', live.manifest)
    running.delete(live.key)
    live.sealError = null
  } catch (error) {
    live.sealError = String(error).slice(0, 256)
    throw error
  }
}

function stop(live: Live, reason: StopReason): Promise<void> {
  if (live.stopping) return live.stopping
  live.stopping = (async () => {
    for (const timer of live.timers) clearInterval(timer)
    for (const detach of live.detach) detach()
    while (live.ticking) await new Promise((resolve) => setTimeout(resolve, 10))
    await live.writes
    const manifest = live.manifest
    let failed = reason === 'write_failed'
    if (live.events) {
      try { await live.events.sync() } catch { failed = true }
      await live.events.close().catch(() => undefined)
      live.events = null
    }
    if (live.collector) {
      const entries = windowEntries(live)
      releaseDiagnostics(live.collector, holderOf(manifest.recordingId))
      try {
        await writeDurableRecord(live.dir, 'diagnostics.json', { format: RECORDING_FORMAT, redaction: REDACTION_POLICY,
          excluded: DIAGNOSTICS_EXCLUDED, ...entries })
      } catch { failed = true; manifest.counters.consoleEntries = 0; manifest.counters.networkEntries = 0 }
    }
    manifest.state = 'stopped'
    manifest.stoppedAtMs = Date.now()
    manifest.stopReason = failed ? 'write_failed' : reason
    await seal(live).catch(() => undefined)
  })()
  return live.stopping
}

async function startRecording(profileId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const recordingId = request.recording_id
  if (!validId(recordingId)) throw new Error('invalid_request: recording_id is invalid')
  const spec: RecordingSpec = recordingSpec(request)
  const key = keyOf(profileId, recordingId)
  const current = running.get(key)
  if (current) {
    if (!sameSpec(spec, current.manifest)) throw new Error('conflict: the recording ID has another target or scope')
    return liveReport(current)
  }
  if (starting.has(key)) throw new Error('unavailable: this recording is starting; repeat the same start')
  starting.add(key)
  try {
    const dir = join(await recordingsRoot(profileId), recordingId)
    const stored = await readManifest(dir, recordingId)
    if (stored) {
      if (!sameSpec(spec, stored)) throw new Error('conflict: the recording ID has another target or scope')
      return await storedReport(dir, stored)
    }
    if (running.size >= RECORDING_LIMITS.maxActive) {
      throw new Error(`unavailable: ${RECORDING_LIMITS.maxActive} recordings are already running; stop one first`)
    }
    const page = await browserTabPage(profileId, spec.tabId)
    if (!page.contents) throw new Error('unavailable: the browser tab has no live page; show or navigate it first')
    const contents = page.contents
    const diagnostics = spec.capture.includes('console') || spec.capture.includes('network')
    // Attach before creating anything, so a debugger conflict leaves no artifact.
    const collector = diagnostics ? await attachDiagnostics(profileId, spec.tabId, holderOf(recordingId)) : null
    if (collector && collector.contents !== contents) {
      releaseDiagnostics(collector, holderOf(recordingId))
      throw new Error('unavailable: the tab page changed while the recording started')
    }
    const manifest: RecordingManifest = { format: RECORDING_FORMAT, recordingId, tabId: spec.tabId,
      capture: spec.capture, intervalMs: spec.intervalMs, maxDurationMs: spec.maxDurationMs, state: 'recording',
      startedAtMs: Date.now(), stoppedAtMs: null, stopReason: null, counters: emptyCounters(), captureEnded: null }
    let events: FileHandle | null = null
    try {
      await mkdir(dir, { mode: 0o700 })
      try {
        await mkdir(join(dir, 'frames'), { mode: 0o700 })
        if (spec.capture.includes('page_events')) events = await open(join(dir, 'page-events.jsonl'), 'wx', 0o600)
        await writeDurableRecord(dir, 'manifest.json', manifest)
      } catch (error) {
        await events?.close().catch(() => undefined)
        // Nothing ran yet, so the half-made directory is only ours to remove.
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    } catch (error) {
      if (collector) releaseDiagnostics(collector, holderOf(recordingId))
      throw new Error(`unavailable: the recording could not be created: ${String(error)}`)
    }
    const seq = Math.max(0, ...(collector ? [...collector.console.items, ...collector.network.items].map((item) => item.seq) : []))
    const live: Live = { key, profileId, dir, manifest, contents, collector,
      start: collector ? { console: mark(collector, 'console', seq), network: mark(collector, 'network', seq) } : null,
      timers: [], events, writes: Promise.resolve(), ticking: false, detach: [], stopping: null, sealError: null }
    running.set(key, live)
    watchPage(live)
    if (spec.capture.includes('page_events')) appendEvent(live, { kind: 'recording_started', url: redactUrl(contents.getURL()) })
    if (spec.capture.includes('screenshots')) {
      live.timers.push(setInterval(() => { void tick(live) }, spec.intervalMs))
      void tick(live)
    }
    live.timers.push(setInterval(() => {
      const reason = limitReached(manifest.counters, manifest, Date.now() - manifest.startedAtMs)
      if (reason) void stop(live, reason)
    }, Math.min(1000, spec.maxDurationMs)))
    return liveReport(live)
  } finally { starting.delete(key) }
}

async function stopRecording(profileId: string, recordingId: unknown): Promise<Record<string, unknown>> {
  if (!validId(recordingId)) throw new Error('invalid_request: recording_id is invalid')
  const live = running.get(keyOf(profileId, recordingId))
  if (live) {
    await stop(live, 'requested')
    // A seal that failed earlier is retried here, never the capture.
    if (live.sealError) await seal(live).catch(() => undefined)
    if (live.sealError) return liveReport(live)
    return report(live.manifest, 'stopped', live.dir)
  }
  return getRecording(profileId, recordingId)
}

async function getRecording(profileId: string, recordingId: unknown): Promise<Record<string, unknown>> {
  if (!validId(recordingId)) throw new Error('invalid_request: recording_id is invalid')
  const live = running.get(keyOf(profileId, recordingId))
  if (live) return liveReport(live)
  const dir = join(await recordingsRoot(profileId), recordingId)
  const stored = await readManifest(dir, recordingId)
  if (!stored) throw new Error('unavailable: the recording does not exist in this profile')
  return storedReport(dir, stored)
}

/** Stops every running recording, as when the owner closes. */
export async function stopAllRecordings(): Promise<void> {
  await Promise.all([...running.values()].map((live) => stop(live, 'owner_stopped')))
}

export function browserRecordingRequest(profileId: string, op: string,
  request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (op === 'browser.recording.start') return startRecording(profileId, request)
  if (op === 'browser.recording.stop') return stopRecording(profileId, request.recording_id)
  return getRecording(profileId, request.recording_id)
}
