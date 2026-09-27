// In-process tests for the pure automation cores (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/browser-automation-core.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  automationPayloadTail,
  boundEvaluation,
  decideAttachment,
  expressionProblem,
  readActionability,
  readProbe,
  selectorProblem,
  textProblem,
  timeoutWithin,
  waitSatisfied,
} from './browser-automation-core.ts'
import { reconcileBrowserEffect } from './browser-reconcile.ts'

test('selectors match the daemon checks', () => {
  for (const good of ['#go', 'button[data-x="a]b"]', 'li:nth-child(2) > a', "a[title='it\\'s']", 'div\\[x']) {
    assert.equal(selectorProblem(good), null, good)
  }
  for (const bad of ['', '   ', 'a\nb', 'a[x', 'a)', 'a[x="y]', 'a(]', 'a\\', 7]) {
    assert.notEqual(selectorProblem(bad), null, String(bad))
  }
  assert.equal(selectorProblem('a'.repeat(1024)), null)
  assert.notEqual(selectorProblem('a'.repeat(1025)), null)
})

test('typed text and expressions are bounded', () => {
  assert.equal(textProblem('line one\n\tline two é'), null)
  assert.notEqual(textProblem(''), null)
  assert.notEqual(textProblem('a\rb'), null)
  assert.notEqual(textProblem('a\u007f'), null)
  assert.equal(textProblem('é'.repeat(4096)), null)
  assert.notEqual(textProblem('é'.repeat(4097)), null)
  assert.equal(expressionProblem('document.title'), null)
  assert.notEqual(expressionProblem('a\0'), null)
  assert.notEqual(expressionProblem('x'.repeat(8193)), null)
  assert.equal(timeoutWithin(undefined, 100, 10_000, 5000), 5000)
  assert.equal(timeoutWithin(99, 100, 10_000, 5000), null)
  assert.equal(timeoutWithin(1.5, 1, 10, 5), null)
})

test('the fingerprint matches the daemon digests', () => {
  // Pinned in crates/ade-daemon/src/bin/daemon/server/browser_automation.rs.
  const digest = (op, tail) =>
    createHash('sha256')
      .update(JSON.stringify([op, 'p', 'o', 't', null, ...tail]))
      .digest('hex')
  assert.equal(
    digest('browser.click', automationPayloadTail('browser.click', 'a[x="1"]')),
    '5053bda4b4e407f7e0d4778a4eb4e3062b4cb75ee9c9bad176888f6ef612b61a',
  )
  assert.equal(
    digest('browser.type', automationPayloadTail('browser.type', 'input', 'é\n\t"\\ \u0001', true)),
    'f14aebf066793a5c0e65f6346941c15167672a180327965776b074aa58d457a3',
  )
  // An absent replace is fingerprinted as false, as the daemon defaults it.
  assert.deepEqual(automationPayloadTail('browser.type', 'i', 'x'), ['i', 'x', false])
})

test('DevTools and foreign debuggers refuse; ADE diagnostics is shared', () => {
  const facts = (devtoolsOpen, debuggerAttached, heldByDiagnostics) => ({
    devtoolsOpen,
    debuggerAttached,
    heldByDiagnostics,
  })
  assert.equal(decideAttachment(facts(false, false, false)).action, 'attach')
  assert.equal(decideAttachment(facts(false, true, true)).action, 'reuse')
  const foreign = decideAttachment(facts(false, true, false))
  assert.equal(foreign.action, 'refuse')
  assert.equal(foreign.reason, 'foreign_debugger')
  for (const [attached, held] of [
    [false, false],
    [true, true],
    [true, false],
  ]) {
    const devtools = decideAttachment(facts(true, attached, held))
    assert.equal(devtools.action, 'refuse')
    assert.equal(devtools.reason, 'devtools_open')
  }
})

test('evaluation results are bounded and side effects refused', () => {
  const ok = (reply) => {
    const out = boundEvaluation(reply)
    assert.equal(out.ok, true)
    return out.evaluation
  }
  assert.deepEqual(ok({ result: { type: 'string', value: 'A' } }), {
    value_type: 'string',
    value: 'A',
    truncated: false,
    exception: null,
  })
  assert.deepEqual(ok({ result: { type: 'undefined' } }).value, null)
  assert.equal(ok({ result: { type: 'number', unserializableValue: 'NaN' } }).value, 'NaN')
  const big = ok({ result: { type: 'object', value: { a: 'x'.repeat(70_000) } } })
  assert.equal(big.truncated, true)
  assert.equal(big.value, null)
  assert.equal(ok({ result: { type: 'object', value: { a: 'x' } } }, 10).value.a, 'x')
  const thrown = ok({
    result: { type: 'object' },
    exceptionDetails: { text: 'Uncaught', exception: { description: `ReferenceError: nope${'!'.repeat(5000)}` } },
  })
  assert.equal(thrown.value_type, null)
  assert.equal([...thrown.exception].length, 1024)
  const refused = boundEvaluation({
    result: { type: 'object' },
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: 'EvalError: Possible side-effect in debug-evaluate' },
    },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'invalid_request')
  assert.equal(boundEvaluation({ result: { type: 'object', subtype: 'promise' } }).code, 'invalid_request')
  assert.equal(boundEvaluation(null).ok, false)
  assert.equal(boundEvaluation({ result: { type: 'weird' } }).ok, false)
})

test('wait states and page answers are read strictly', () => {
  const absent = { present: false, visible: false }
  const hiddenOne = { present: true, visible: false }
  const shown = { present: true, visible: true }
  assert.deepEqual(
    [absent, hiddenOne, shown].map((probe) => waitSatisfied('attached', probe)),
    [false, true, true],
  )
  assert.deepEqual(
    [absent, hiddenOne, shown].map((probe) => waitSatisfied('visible', probe)),
    [false, false, true],
  )
  assert.deepEqual(
    [absent, hiddenOne, shown].map((probe) => waitSatisfied('detached', probe)),
    [true, false, false],
  )
  assert.deepEqual(
    [absent, hiddenOne, shown].map((probe) => waitSatisfied('hidden', probe)),
    [true, true, false],
  )
  assert.deepEqual(readProbe({ present: false, visible: true }), absent)
  assert.equal(readProbe({ error: 'invalid_selector' }), 'invalid_selector')
  assert.equal(readProbe('yes'), null)
  assert.deepEqual(readActionability({ ok: true, point: { x: 3, y: 4 } }), { ok: true, point: { x: 3, y: 4 } })
  assert.equal(readActionability({ ok: true, point: { x: -1, y: 4 } }).ok, false)
  assert.equal(readActionability({ ok: false, reason: 'invalid_selector' }).code, 'invalid_request')
  const late = readActionability({ ok: false, reason: 'timeout', detail: '<script>' })
  assert.equal(late.code, 'unavailable')
  assert.match(late.message, /not actionable$/)
})

test('an interrupted click or type settles only from its dispatch mark', () => {
  const tabs = new Map([['tab', { requestedUrl: 'https://a.test/' }]])
  for (const op of ['browser.click', 'browser.type']) {
    const intent = (stage) => ({ op, target: 'tab', url: null, priorUrl: null, stage })
    assert.deepEqual(reconcileBrowserEffect(intent('prepared'), false, tabs), {
      outcome: 'not_applied',
      evidence: 'input_not_dispatched',
    })
    assert.deepEqual(reconcileBrowserEffect(intent('dispatching'), false, tabs), {
      outcome: 'unknown',
      evidence: 'input_unobservable',
    })
    assert.equal(reconcileBrowserEffect(intent(undefined), false, tabs).outcome, 'unknown')
    // A closed tab proves nothing about input already sent.
    assert.equal(reconcileBrowserEffect(intent('dispatching'), false, new Map()).outcome, 'unknown')
    assert.equal(reconcileBrowserEffect(intent('prepared'), true, tabs).outcome, 'unknown')
  }
})
