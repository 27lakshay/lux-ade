// In-process tests for the pure reconciliation decider (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/browser-reconcile.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcileBrowserEffect } from './browser-reconcile.ts'

const tabs = (entries) => new Map(entries.map(([id, requestedUrl]) => [id, { requestedUrl }]))
const open = { op: 'browser.open', target: 'planned', url: 'https://a.test/', priorUrl: null }
const navigate = { op: 'browser.navigate', target: 'tab', url: 'https://b.test/', priorUrl: 'https://a.test/' }
const close = { op: 'browser.close', target: 'tab', url: null, priorUrl: null }

test('nothing is decided while the same request is still running', () => {
  for (const intent of [open, navigate, close]) {
    assert.deepEqual(
      reconcileBrowserEffect(
        intent,
        true,
        tabs([
          ['planned', open.url],
          ['tab', navigate.url],
        ]),
      ),
      { outcome: 'unknown', evidence: 'effect_in_progress' },
    )
  }
})

test('a receipt without recorded intent stays unknown', () => {
  assert.equal(reconcileBrowserEffect(null, false, tabs([])).outcome, 'unknown')
  assert.equal(reconcileBrowserEffect({ ...close, target: null }, false, tabs([])).outcome, 'unknown')
  assert.equal(reconcileBrowserEffect({ ...open, url: null }, false, tabs([['planned', '']])).outcome, 'unknown')
  assert.equal(
    reconcileBrowserEffect({ ...navigate, priorUrl: null }, false, tabs([['tab', navigate.url]])).outcome,
    'unknown',
  )
})

test('an open settles from its planned tab and never names another tab', () => {
  assert.deepEqual(
    reconcileBrowserEffect(
      open,
      false,
      tabs([
        ['planned', open.url],
        ['other', open.url],
      ]),
    ),
    { outcome: 'applied', tabId: 'planned', evidence: 'planned_tab_present' },
  )
  // A later navigation of the planned tab does not undo the open.
  assert.equal(reconcileBrowserEffect(open, false, tabs([['planned', 'https://z.test/']])).outcome, 'applied')
  // Another tab at the same URL is not evidence that this open ran.
  assert.deepEqual(reconcileBrowserEffect(open, false, tabs([['other', open.url]])), {
    outcome: 'not_applied',
    evidence: 'planned_tab_absent',
  })
})

test('a navigate settles only when the tab URL proves one side', () => {
  assert.deepEqual(reconcileBrowserEffect(navigate, false, tabs([['tab', navigate.url]])), {
    outcome: 'applied',
    tabId: 'tab',
    evidence: 'tab_at_requested_url',
  })
  assert.deepEqual(reconcileBrowserEffect(navigate, false, tabs([['tab', navigate.priorUrl]])), {
    outcome: 'not_applied',
    evidence: 'tab_at_prior_url',
  })
  assert.deepEqual(reconcileBrowserEffect(navigate, false, tabs([['tab', 'https://c.test/']])), {
    outcome: 'unknown',
    evidence: 'tab_at_other_url',
  })
  assert.deepEqual(reconcileBrowserEffect(navigate, false, tabs([])), {
    outcome: 'unknown',
    evidence: 'target_tab_absent',
  })
  // Navigating to the URL the tab already had is applied, not "not applied".
  const same = { ...navigate, url: navigate.priorUrl }
  assert.equal(reconcileBrowserEffect(same, false, tabs([['tab', navigate.priorUrl]])).outcome, 'applied')
})

test('a close settles from whether its target tab remains', () => {
  assert.deepEqual(reconcileBrowserEffect(close, false, tabs([['other', 'https://a.test/']])), {
    outcome: 'applied',
    tabId: 'tab',
    evidence: 'target_tab_absent',
  })
  assert.deepEqual(reconcileBrowserEffect(close, false, tabs([['tab', 'https://a.test/']])), {
    outcome: 'not_applied',
    evidence: 'target_tab_present',
  })
})
