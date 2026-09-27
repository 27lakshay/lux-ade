// In-process tests for the pure snooze wake-time parser (AGENTS.md test policy).
// Run: node --test apps/cli/src/commands/wake-time.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseWakeTime } from './wake-time.ts'

const now = 1_000_000

test('relative times add minutes, hours or days to now', () => {
  assert.equal(parseWakeTime('+30m', now), now + 30 * 60_000)
  assert.equal(parseWakeTime('+2h', now), now + 2 * 3_600_000)
  assert.equal(parseWakeTime('+1d', now), now + 86_400_000)
})

test('absolute times need an explicit zone or are epoch milliseconds', () => {
  assert.equal(parseWakeTime('2026-10-01T09:00:00Z', now), Date.UTC(2026, 9, 1, 9))
  assert.equal(parseWakeTime('2026-10-01T09:00:00+05:30', now), Date.UTC(2026, 9, 1, 3, 30))
  assert.equal(parseWakeTime('1790000000000', now), 1_790_000_000_000)
  assert.equal(parseWakeTime('2026-10-01T09:00:00', now), undefined)
})

test('anything else is refused', () => {
  for (const text of ['', '+0m', '-5m', '+5s', 'tomorrow', '0', '2026-13-45T99:99:99Z', '+5 m']) {
    assert.equal(parseWakeTime(text, now), undefined, text)
  }
})
