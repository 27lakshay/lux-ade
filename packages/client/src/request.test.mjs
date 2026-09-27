// Pure-core tests for the daemon refusal decision (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/request.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categoryErrorCodes, DaemonRequestError, daemonRefusalCodes, isDaemonRefusal } from '../dist/request.js'

const replied = (code) => new DaemonRequestError(code, 'refused', 'unknown', true)

test('a replied specific code, a code-less frame and an unlisted future code are daemon refusals', () => {
  for (const code of [...daemonRefusalCodes, 'daemon', 'rate_limit', 'some_future_code']) {
    assert.equal(isDaemonRefusal(replied(code)), true, code)
  }
})

test('a general category is not a daemon refusal, even when the daemon replied it', () => {
  for (const code of categoryErrorCodes.filter((code) => code !== 'daemon')) {
    assert.equal(isDaemonRefusal(replied(code)), false, code)
  }
})

test('an error the client raised itself is never a daemon refusal', () => {
  assert.equal(isDaemonRefusal(new DaemonRequestError('needs_rebind', 'local', 'not_sent', false)), false)
})

test('the recovery hint travels on the error', () => {
  const error = new DaemonRequestError('needs_rebind', 'm', 'unknown', true, 'rebind_workspace')
  assert.equal(error.recovery, 'rebind_workspace')
  assert.equal(new DaemonRequestError('timeout', 'm').recovery, undefined)
})
