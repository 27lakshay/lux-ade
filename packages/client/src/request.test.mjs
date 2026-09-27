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

test('the control lane socket sits beside the profile socket', async () => {
  const { controlSocketPath, controlOperations } = await import('../dist/request.js')
  assert.equal(controlSocketPath('/tmp/ade-501-abc.sock'), '/tmp/ade-501-abc.control.sock')
  assert.equal(controlSocketPath('/tmp/d'), '/tmp/d.control')
  for (const op of ['agent.cancel', 'terminal.stop', 'service.stop', 'hello', 'runtime.prepare_restart']) {
    assert.equal(controlOperations.has(op), true, op)
  }
  for (const op of ['agent.send', 'conversation.get', 'session.subscribe'])
    assert.equal(controlOperations.has(op), false, op)
})
