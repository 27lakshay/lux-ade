// In-process tests for the pure recording cores (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/browser-recording-core.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  coverageGaps,
  emptyCounters,
  limitReached,
  RECORDING_FORMAT,
  RECORDING_LIMITS,
  recordingSpec,
  reportedState,
  sameSpec,
  validManifest,
} from './browser-recording-core.ts'

const manifest = (overrides = {}) => ({
  format: RECORDING_FORMAT,
  recordingId: 'r1',
  tabId: 't1',
  capture: ['screenshots', 'page_events'],
  intervalMs: 2000,
  maxDurationMs: 300000,
  state: 'recording',
  startedAtMs: 10,
  stoppedAtMs: null,
  stopReason: null,
  counters: emptyCounters(),
  captureEnded: null,
  ...overrides,
})

test('a spec applies defaults and orders capture kinds canonically', () => {
  assert.deepEqual(recordingSpec({ tab_id: 't1', capture: ['network', 'screenshots'] }), {
    tabId: 't1',
    capture: ['screenshots', 'network'],
    intervalMs: 2000,
    maxDurationMs: 300000,
  })
  for (const bad of [
    { tab_id: '../t', capture: ['screenshots'] },
    { tab_id: 't1', capture: [] },
    { tab_id: 't1', capture: ['video'] },
    { tab_id: 't1', capture: ['console', 'console'] },
    { tab_id: 't1', capture: ['screenshots'], interval_ms: 100 },
    { tab_id: 't1', capture: ['screenshots'], max_duration_ms: 1.5e6 * 2 },
    { tab_id: 't1', capture: ['screenshots'], interval_ms: 1000.5 },
  ])
    assert.throws(() => recordingSpec(bad), /invalid_request/)
})

test('a repeated start matches only the same target and scope', () => {
  const spec = recordingSpec({ tab_id: 't1', capture: ['page_events', 'screenshots'] })
  assert.equal(sameSpec(spec, manifest()), true)
  assert.equal(sameSpec({ ...spec, tabId: 't2' }, manifest()), false)
  assert.equal(sameSpec({ ...spec, capture: ['screenshots'] }, manifest()), false)
  assert.equal(sameSpec({ ...spec, intervalMs: 1000 }, manifest()), false)
})

test('a manifest from disk is validated, not repaired', () => {
  assert.equal(validManifest(manifest(), 'r1').tabId, 't1')
  const stopped = manifest({ state: 'stopped', stoppedAtMs: 20, stopReason: 'requested' })
  assert.equal(validManifest(stopped, 'r1').state, 'stopped')
  for (const bad of [
    null,
    manifest({ recordingId: 'other' }),
    manifest({ format: 'v0' }),
    manifest({ state: 'stopped' }),
    manifest({ stopReason: 'requested' }),
    manifest({ stopReason: 'exploded', stoppedAtMs: 1, state: 'stopped' }),
    manifest({ capture: ['video'] }),
    manifest({ counters: { ...emptyCounters(), frames: -1 } }),
    manifest({ counters: { frames: 1 } }),
    manifest({ captureEnded: 7 }),
  ])
    assert.throws(() => validManifest(bad, 'r1'), /invalid/)
})

test('an unsealed recording this owner is not running is interrupted, never resumed', () => {
  assert.equal(reportedState(manifest(), true), 'recording')
  assert.equal(reportedState(manifest(), false), 'interrupted')
  assert.equal(reportedState(manifest({ state: 'stopped', stoppedAtMs: 2, stopReason: 'requested' }), false), 'stopped')
})

test('limits stop a recording by duration, frames or size', () => {
  const spec = { maxDurationMs: 1000 }
  assert.equal(limitReached(emptyCounters(), spec, 999), null)
  assert.equal(limitReached(emptyCounters(), spec, 1000), 'duration_reached')
  assert.equal(limitReached({ ...emptyCounters(), frames: RECORDING_LIMITS.maxFrames }, spec, 0), 'frame_limit')
  assert.equal(limitReached({ ...emptyCounters(), bytes: RECORDING_LIMITS.maxBytes }, spec, 0), 'size_limit')
})

test('coverage gaps disclose scope, losses and interruption', () => {
  const plain = coverageGaps(manifest(), 'recording')
  assert.ok(plain.some((gap) => gap.startsWith('no video')))
  assert.ok(plain.includes('user input inside the page (clicks, typing, scrolling) is not recorded'))
  assert.ok(plain.includes('console messages were not requested'))
  assert.ok(plain.includes('network requests were not requested'))
  const lossy = coverageGaps(
    manifest({
      capture: ['console', 'network'],
      state: 'stopped',
      stoppedAtMs: 5,
      stopReason: 'target_closed',
      captureEnded: 'canceled_by_user',
      counters: { ...emptyCounters(), framesUnavailable: 2, consoleEvicted: 3, pageEventsDropped: 4 },
    }),
    'stopped',
  )
  for (const expected of [
    'screenshots were not requested',
    'page events were not requested',
    '2 screenshot ticks',
    '3 console entries were evicted',
    '4 page events beyond',
    'the tab closed',
    'canceled_by_user',
    'headers, cookies and bodies are never captured',
    'still in flight',
  ]) {
    assert.ok(
      lossy.some((gap) => gap.includes(expected)),
      `missing ${expected}`,
    )
  }
  assert.ok(coverageGaps(manifest(), 'interrupted').some((gap) => gap.includes('interrupted before it was sealed')))
})
