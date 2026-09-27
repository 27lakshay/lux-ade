// In-process tests for the remote reply deadlines (AGENTS.md test policy).
// Run: node --test apps/cli/src/commands/remote-deadline.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteDeadlineMs } from './remote-deadline.ts'

test('the CLI outlasts the daemon ssh budget of each remote request', () => {
  // remote.host.start: 45 s probe + 60 s start script in one request.
  assert.ok(remoteDeadlineMs('remote.host.start') > 105_000)
  assert.ok(remoteDeadlineMs('remote.host.probe') > 45_000)
  // remote.host.add: 10 s ssh -G + 30 s ssh-keyscan.
  assert.ok(remoteDeadlineMs('remote.host.add') > 40_000)
  // remote.host.install: two 45 s probes + three 120 s uploads.
  assert.ok(remoteDeadlineMs('remote.host.install') > 450_000)
  assert.equal(remoteDeadlineMs('remote.host.list'), 30_000)
})
