// Pure cores for browser recording (F097, decision D11): the recording spec, its
// idempotent-start comparison, the manifest a recording seals, its limits, the
// state a reader reports and the coverage gaps it discloses. Nothing here touches
// Electron or the file system (AGENTS.md test policy).

export const RECORDING_FORMAT = 'ade-browser-recording-v1'
export const CAPTURE_KINDS = ['screenshots', 'page_events', 'console', 'network'] as const
export type CaptureKind = typeof CAPTURE_KINDS[number]
export const RECORDING_LIMITS = { maxFrames: 900, maxBytes: 256 * 1024 * 1024, maxPageEvents: 2000, maxActive: 2 }
export type StopReason = 'requested' | 'duration_reached' | 'frame_limit' | 'size_limit' | 'target_closed' |
  'write_failed' | 'owner_stopped'
const STOP_REASONS: readonly StopReason[] = ['requested', 'duration_reached', 'frame_limit', 'size_limit',
  'target_closed', 'write_failed', 'owner_stopped']

export type RecordingSpec = { tabId: string; capture: CaptureKind[]; intervalMs: number; maxDurationMs: number }
export type RecordingCounters = { frames: number; framesUnavailable: number; pageEvents: number; pageEventsDropped: number
  consoleEntries: number; networkEntries: number; consoleEvicted: number; networkEvicted: number; bytes: number }
export type RecordingManifest = { format: typeof RECORDING_FORMAT; recordingId: string; tabId: string
  capture: CaptureKind[]; intervalMs: number; maxDurationMs: number; state: 'recording' | 'stopped'
  startedAtMs: number; stoppedAtMs: number | null; stopReason: StopReason | null; counters: RecordingCounters
  /** Why console and network capture ended or restarted inside the window, or null. */
  captureEnded: string | null }
export type ReportedState = 'recording' | 'stopped' | 'interrupted'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

export function emptyCounters(): RecordingCounters {
  return { frames: 0, framesUnavailable: 0, pageEvents: 0, pageEventsDropped: 0, consoleEntries: 0, networkEntries: 0,
    consoleEvicted: 0, networkEvicted: 0, bytes: 0 }
}

/**
 * Validates a start request into a spec with its defaults applied and its
 * capture kinds in canonical order, so equal requests compare equal.
 */
export function recordingSpec(request: Record<string, unknown>): RecordingSpec {
  const fail = (message: string): never => { throw new Error(`invalid_request: ${message}`) }
  if (typeof request.tab_id !== 'string' || !ID.test(request.tab_id)) fail('tab_id is invalid')
  if (!Array.isArray(request.capture) || request.capture.length === 0) fail('capture needs at least one kind')
  const kinds = request.capture as unknown[]
  if (kinds.some((kind) => !CAPTURE_KINDS.includes(kind as CaptureKind)) || new Set(kinds).size !== kinds.length) {
    fail('capture kinds must be distinct known kinds')
  }
  const interval = request.interval_ms ?? 2000
  const duration = request.max_duration_ms ?? 300_000
  if (!whole(interval, 250, 60_000)) fail('interval_ms must be between 250 and 60000')
  if (!whole(duration, 1000, 1_800_000)) fail('max_duration_ms must be between 1000 and 1800000')
  return { tabId: request.tab_id as string, capture: CAPTURE_KINDS.filter((kind) => kinds.includes(kind)),
    intervalMs: interval as number, maxDurationMs: duration as number }
}

/** True when a repeated start names the same target and scope as the manifest. */
export function sameSpec(spec: RecordingSpec, manifest: RecordingManifest): boolean {
  return spec.tabId === manifest.tabId && spec.intervalMs === manifest.intervalMs &&
    spec.maxDurationMs === manifest.maxDurationMs && spec.capture.join(',') === manifest.capture.join(',')
}

/** Validates a manifest read from disk; anything else is refused, not repaired. */
export function validManifest(value: unknown, recordingId: string): RecordingManifest {
  const fail = (): never => { throw new Error('Browser recording manifest is invalid; preserve it for review') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const item = value as RecordingManifest
  const counters = item.counters as Record<string, unknown> | undefined
  const max = Number.MAX_SAFE_INTEGER
  if (item.format !== RECORDING_FORMAT || item.recordingId !== recordingId || typeof item.tabId !== 'string' ||
    !ID.test(item.tabId) || !Array.isArray(item.capture) || item.capture.length === 0 ||
    item.capture.some((kind) => !CAPTURE_KINDS.includes(kind)) || !whole(item.intervalMs, 250, 60_000) ||
    !whole(item.maxDurationMs, 1000, 1_800_000) || !['recording', 'stopped'].includes(item.state) ||
    !whole(item.startedAtMs, 0, max) ||
    !(item.stoppedAtMs === null || whole(item.stoppedAtMs, 0, max)) ||
    !(item.stopReason === null || STOP_REASONS.includes(item.stopReason)) ||
    (item.state === 'stopped') !== (item.stoppedAtMs !== null) ||
    (item.state === 'stopped') !== (item.stopReason !== null) ||
    !(item.captureEnded === null || (typeof item.captureEnded === 'string' && item.captureEnded.length <= 128)) ||
    !counters || typeof counters !== 'object' ||
    Object.keys(emptyCounters()).some((key) => !whole(counters[key], 0, max))) fail()
  return item
}

/**
 * The state a reader reports. A manifest still marked `recording` that this
 * owner is not running was cut short by a crash or quit: it is interrupted,
 * and it is never resumed.
 */
export function reportedState(manifest: RecordingManifest, running: boolean): ReportedState {
  if (manifest.state === 'stopped') return 'stopped'
  return running ? 'recording' : 'interrupted'
}

/** The limit a running recording has reached, or null to keep going. */
export function limitReached(counters: RecordingCounters, spec: Pick<RecordingSpec, 'maxDurationMs'>,
  elapsedMs: number): StopReason | null {
  if (elapsedMs >= spec.maxDurationMs) return 'duration_reached'
  if (counters.frames >= RECORDING_LIMITS.maxFrames) return 'frame_limit'
  if (counters.bytes >= RECORDING_LIMITS.maxBytes) return 'size_limit'
  return null
}

/** Everything the recording does not cover, stated plainly for its reader. */
export function coverageGaps(manifest: RecordingManifest, state: ReportedState): string[] {
  const has = (kind: CaptureKind): boolean => manifest.capture.includes(kind)
  const c = manifest.counters
  const gaps = [
    has('screenshots') ? `no video: screenshots are PNG stills taken every ${manifest.intervalMs} ms`
      : 'screenshots were not requested',
    'user input inside the page (clicks, typing, scrolling) is not recorded',
    'child frames, popups, dialogs and downloads are not recorded',
  ]
  if (!has('page_events')) gaps.push('page events were not requested')
  if (!has('console')) gaps.push('console messages were not requested')
  if (!has('network')) gaps.push('network requests were not requested')
  if (has('console') || has('network')) {
    gaps.push('console and network entries are redacted; headers, cookies and bodies are never captured')
  }
  if (has('network')) gaps.push('requests still in flight when the recording ended are not included')
  if (manifest.captureEnded) {
    gaps.push(`console and network capture was interrupted inside the window (${manifest.captureEnded}); entries from then on may be missing`)
  }
  if (c.framesUnavailable) gaps.push(`${c.framesUnavailable} screenshot ticks produced no image, as when the page was hidden`)
  if (c.pageEventsDropped) {
    gaps.push(`${c.pageEventsDropped} page events beyond the ${RECORDING_LIMITS.maxPageEvents}-event limit were not recorded`)
  }
  if (c.consoleEvicted) gaps.push(`${c.consoleEvicted} console entries were evicted from the capture buffer before the recording ended`)
  if (c.networkEvicted) gaps.push(`${c.networkEvicted} network entries were evicted from the capture buffer before the recording ended`)
  if (manifest.stopReason === 'target_closed') gaps.push('the tab closed before the recording window ended')
  if (manifest.stopReason === 'write_failed') gaps.push('a file write failed; the recording ends at the last file written')
  if (manifest.stopReason === 'frame_limit') gaps.push(`the recording reached its ${RECORDING_LIMITS.maxFrames}-frame limit`)
  if (manifest.stopReason === 'size_limit') gaps.push('the recording reached its 256 MiB size limit')
  if (state === 'interrupted') {
    gaps.push('the recording was interrupted before it was sealed; its counts are the files on disk, and ' +
      'console and network entries were not saved')
  }
  return gaps
}
