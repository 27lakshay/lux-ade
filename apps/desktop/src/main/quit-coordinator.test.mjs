// In-process tests for the pure quit coordinator (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/quit-coordinator.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QuitCoordinator } from './quit-coordinator.ts'

const settle = () => new Promise((done) => setImmediate(done))
const quitEvent = () => {
  const event = {
    prevented: false,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

// A fake Electron quit: before-quit, then (when nothing held it) the window close
// handlers, then will-quit. Returns what happened.
function harness() {
  const log = []
  let windowCancels = false
  const quit = new QuitCoordinator(
    () => {
      log.push('requestQuit')
      attempt()
    },
    (error) => log.push(`error:${error}`),
  )
  function attempt() {
    const before = quitEvent()
    quit.holdQuit(before)
    if (before.prevented) {
      log.push('held')
      return
    }
    if (windowCancels) {
      log.push('window-cancelled')
      return
    }
    const will = quitEvent()
    log.push('will-quit')
    quit.finishQuit(will)
    // Teardown may already have re-entered the quit; record the exit only here.
    if (!will.prevented) log.push('quit')
  }
  return {
    quit,
    log,
    attempt,
    setWindowCancels: (value) => {
      windowCancels = value
    },
  }
}

test('a guard that released before a later guard failed is asked again on the next quit', async () => {
  const { quit, log, attempt } = harness()
  let draftDirty = true
  let draftFlushes = 0
  let browserOk = false
  quit.registerGuard(() =>
    draftDirty
      ? async () => {
          draftFlushes += 1
          draftDirty = false
          return true
        }
      : null,
  )
  quit.registerGuard(() => async () => browserOk)
  attempt()
  await settle()
  assert.equal(draftFlushes, 1)
  assert.deepEqual(log.slice(-2), ['requestQuit', 'held'], 'the browser guard keeps ADE open')
  // The person edits a draft again; the next quit must run the draft guard.
  draftDirty = true
  browserOk = true
  attempt()
  await settle()
  assert.equal(draftFlushes, 2)
})

test('a failing first guard keeps ADE open and is asked again', async () => {
  const { quit, log, attempt } = harness()
  let calls = 0
  quit.registerGuard(() => async () => {
    calls += 1
    return calls > 1
  })
  attempt()
  await settle()
  assert.deepEqual(log, ['held'])
  attempt()
  await settle()
  assert.equal(calls, 2)
  assert.equal(log.at(-1), 'quit')
})

test('a window that cancels the quit leaves teardown unrun and guards re-armed', async () => {
  const { quit, log, attempt, setWindowCancels } = harness()
  let torn = 0
  let guardRuns = 0
  quit.registerGuard(() => async () => {
    guardRuns += 1
    return true
  })
  quit.registerTeardown(() => {
    torn += 1
  })
  setWindowCancels(true)
  attempt()
  await settle()
  assert.equal(torn, 0, 'the client, terminals and browser owner stay up')
  assert.equal(log.at(-1), 'window-cancelled')
  setWindowCancels(false)
  attempt()
  await settle()
  assert.equal(guardRuns, 2, 'the guard ran again on the second quit')
  assert.equal(torn, 1)
  assert.equal(log.at(-1), 'quit')
})

test('teardown runs once, in order, even when one step throws', async () => {
  const { quit, log, attempt } = harness()
  const order = []
  quit.registerTeardown(async () => {
    order.push('owner')
    throw new Error('unregister failed')
  })
  quit.registerTeardown(() => {
    order.push('client')
  })
  attempt()
  await settle()
  assert.deepEqual(order, ['owner', 'client'])
  assert.ok(log.includes('error:Error: unregister failed'))
  assert.equal(log.at(-1), 'quit')
})

test('guards are not asked again once teardown has started', async () => {
  const { quit, attempt } = harness()
  let guardRuns = 0
  quit.registerGuard(() => {
    guardRuns += 1
    return null
  })
  attempt()
  await settle()
  assert.equal(guardRuns, 1)
})

test('a rejected flush keeps ADE open and re-arms every guard', async () => {
  const { quit, log, attempt } = harness()
  let first = 0
  let fail = true
  quit.registerGuard(() => async () => {
    first += 1
    return true
  })
  quit.registerGuard(() => async () => {
    if (fail) throw new Error('disk')
    return true
  })
  attempt()
  await settle()
  assert.equal(log.at(-1), 'error:Error: disk')
  fail = false
  attempt()
  await settle()
  assert.equal(first, 2)
  assert.equal(log.at(-1), 'quit')
})
