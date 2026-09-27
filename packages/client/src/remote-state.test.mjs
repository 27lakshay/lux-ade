// Pure-core tests for the remote reconnect and host-pinning state machine
// (AGENTS.md test policy). Run after `pnpm build:sdk`:
// node --test packages/client/src/remote-state.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  admitRemoteRequest, classifySshExit, connectionKey, initialRemoteState, reduceRemote, remoteStatus,
  retryDelay, sshForwardArgs, validateLocalSocket, validateTarget,
} from '../dist/remote-state.js'

const target = { hostId: 'build-box', profileId: 'p-1', destination: 'me@build.lan',
  remoteSocket: '/home/me/.ade/profiles/p-1/daemon.sock' }
const hello = (runtimeSocket = '/home/me/.ade/profiles/p-1/runtime.sock', boot = 'boot-1') => ({
  type: 'hello', application_protocol: 'ade-application-v1', session_protocol: 'ade-sessions-v1',
  runtime_socket: runtimeSocket, boot_id: boot, build_id: null,
})

function run(state, ...events) {
  const effects = []
  for (const event of events) {
    const step = reduceRemote(state, event)
    state = step.state
    effects.push(...step.effects)
  }
  return { state, effects }
}

function connected() {
  return run(initialRemoteState(target), { type: 'start' }, { type: 'forward_ready' },
    { type: 'hello', hello: hello() }).state
}

test('connects through forward, handshake and pins the profile runtime', () => {
  const { state, effects } = run(initialRemoteState(target), { type: 'start' }, { type: 'forward_ready' },
    { type: 'hello', hello: hello() })
  assert.equal(state.phase, 'connected')
  assert.deepEqual(effects.map((effect) => effect.type), ['spawn_forward', 'send_hello'])
  assert.equal(state.pinned.runtimeSocket, '/home/me/.ade/profiles/p-1/runtime.sock')
  assert.equal(remoteStatus(state), 'connected')
})

test('link loss reports unknown and schedules a reconnect to the same target only', () => {
  const { state, effects } = run(connected(), { type: 'link_lost', detail: 'Socket closed.' })
  assert.equal(state.phase, 'unknown')
  assert.equal(remoteStatus(state), 'unknown')
  assert.equal(state.key, connectionKey(target))
  assert.deepEqual(effects, [{ type: 'kill_forward' }, { type: 'schedule_retry', delayMs: 500 }])
  const retried = run(state, { type: 'retry_due' })
  assert.deepEqual(retried.effects, [{ type: 'spawn_forward' }])
  // Mid-reconnect the host still reads as unknown, not connecting to something new.
  assert.equal(remoteStatus(retried.state), 'unknown')
})

test('requests are refused unsent while unknown, and never admitted for another profile', () => {
  const lost = run(connected(), { type: 'link_lost', detail: 'x' }).state
  const admission = admitRemoteRequest(lost, target)
  assert.equal(admission.admitted, false)
  assert.match(admission.reason, /unknown.*not sent/)
  assert.deepEqual(admitRemoteRequest(connected(), target), { admitted: true })
  assert.equal(admitRemoteRequest(connected(), { ...target, profileId: 'p-2' }).admitted, false)
})

test('a daemon restart on the same profile reconnects; a different profile fails closed', () => {
  const lost = run(connected(), { type: 'link_lost', detail: 'x' }, { type: 'retry_due' }, { type: 'forward_ready' }).state
  const restarted = run(lost, { type: 'hello', hello: hello(undefined, 'boot-2') }).state
  assert.equal(restarted.phase, 'connected')
  assert.equal(restarted.current.bootId, 'boot-2')
  const moved = run(lost, { type: 'hello', hello: hello('/home/other/.ade/profiles/p-9/runtime.sock') })
  assert.equal(moved.state.phase, 'failed')
  assert.equal(moved.state.failure, 'identity_mismatch')
  assert.deepEqual(moved.effects, [{ type: 'kill_forward' }, { type: 'cancel_retry' }])
  // An explicit restart keeps the pin, so the wrong profile is still refused.
  const again = run(moved.state, { type: 'start' }, { type: 'forward_ready' },
    { type: 'hello', hello: hello('/home/other/.ade/profiles/p-9/runtime.sock') }).state
  assert.equal(again.failure, 'identity_mismatch')
})

test('untrusted host keys and failed authentication stop instead of retrying', () => {
  const started = run(initialRemoteState(target), { type: 'start' }).state
  const untrusted = run(started, { type: 'forward_failed', exitCode: 255, stderr: 'Host key verification failed.\n' })
  assert.equal(untrusted.state.failure, 'host_untrusted')
  assert.ok(!untrusted.effects.some((effect) => effect.type === 'schedule_retry'))
  const denied = run(started, { type: 'forward_failed', exitCode: 255, stderr: 'me@build.lan: Permission denied (publickey).' })
  assert.equal(denied.state.failure, 'auth_failed')
  const flaky = run(started, { type: 'forward_failed', exitCode: 255, stderr: 'Connection timed out' })
  assert.equal(flaky.state.phase, 'unknown')
  assert.equal(classifySshExit('No ED25519 host key is known for build.lan and you have requested strict checking.'),
    'host_untrusted')
})

test('an incompatible daemon fails closed', () => {
  const started = run(initialRemoteState(target), { type: 'start' }, { type: 'forward_ready' }).state
  const wrong = run(started, { type: 'hello', hello: { ...hello(), application_protocol: 'ade-application-v0' } })
  assert.equal(wrong.state.failure, 'incompatible')
  const missing = run(started, { type: 'hello', hello: { ...hello(), runtime_socket: undefined } })
  assert.equal(missing.state.failure, 'incompatible')
})

test('stale events do not resurrect a stopped connection', () => {
  const stopped = run(connected(), { type: 'stop' })
  assert.equal(stopped.state.phase, 'stopped')
  assert.deepEqual(stopped.effects, [{ type: 'kill_forward' }, { type: 'cancel_retry' }])
  for (const event of [{ type: 'retry_due' }, { type: 'forward_ready' }, { type: 'hello', hello: hello() },
    { type: 'link_lost', detail: 'x' }]) {
    assert.equal(reduceRemote(stopped.state, event).state.phase, 'stopped')
  }
})

test('backoff grows and caps', () => {
  assert.deepEqual([1, 2, 3, 7, 20].map(retryDelay), [500, 1000, 2000, 30_000, 30_000])
})

test('targets reject option injection and unusable paths', () => {
  assert.equal(validateTarget(target), null)
  assert.ok(validateTarget({ ...target, destination: '-oProxyCommand=sh' }))
  assert.ok(validateTarget({ ...target, remoteSocket: 'relative.sock' }))
  assert.ok(validateTarget({ ...target, remoteSocket: '/a/../b.sock' }))
  assert.ok(validateTarget({ ...target, hostId: '' }))
  const invalid = initialRemoteState({ ...target, destination: '-x' })
  assert.equal(invalid.failure, 'invalid_target')
  assert.equal(reduceRemote(invalid, { type: 'start' }).state.phase, 'failed')
  assert.ok(validateLocalSocket(`/${'x'.repeat(120)}`))
})

test('ssh arguments forward the socket, pin host keys and end options before the destination', () => {
  const args = sshForwardArgs(target, '/tmp/ade-remote-1/daemon.sock')
  assert.deepEqual(args.slice(-2), ['--', 'me@build.lan'])
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('BatchMode=yes'))
  const forward = args[args.indexOf('-L') + 1]
  assert.equal(forward, '/tmp/ade-remote-1/daemon.sock:/home/me/.ade/profiles/p-1/daemon.sock')
})

test('connection keys separate hosts and profiles', () => {
  assert.notEqual(connectionKey(target), connectionKey({ ...target, hostId: 'other' }))
  assert.notEqual(connectionKey(target), connectionKey({ ...target, profileId: 'p-2' }))
  assert.notEqual(connectionKey({ hostId: 'a:b', profileId: 'c' }), connectionKey({ hostId: 'a', profileId: 'b:c' }))
})
