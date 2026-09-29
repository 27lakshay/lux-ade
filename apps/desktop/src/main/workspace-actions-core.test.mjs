// In-process tests for the workspace removal wording (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/workspace-actions-core.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockerText, blockerTexts } from './workspace-actions-core.ts'

test('workspace blockers name what is running', () => {
  assert.equal(
    blockerText({ kind: 'conversation_running', id: 'c', label: 'Fix the build' }),
    '“Fix the build” is running',
  )
  assert.equal(blockerText({ kind: 'service_running', id: 's', label: 'Service web' }), 'Service web is running')
  assert.equal(
    blockerText({ kind: 'default_workspace', id: 'w', label: "The daemon's default workspace" }),
    'ADE keeps this workspace for itself',
  )
})

test('worktree blockers read as reasons; an unknown kind keeps the daemon’s label', () => {
  assert.equal(blockerText({ kind: 'dirty', id: '/t', label: 'dirty' }), 'It has uncommitted or untracked files')
  assert.equal(blockerText({ kind: 'primary_checkout', id: '/t', label: 'x' }), 'It is the project’s main checkout')
  assert.equal(blockerText({ kind: 'brand_new', id: 'x', label: 'Something new' }), 'Something new')
})

test('each reason is listed once', () => {
  assert.deepEqual(
    blockerTexts([
      { kind: 'unavailable', id: 'a', label: '' },
      { kind: 'not_listed', id: 'a', label: '' },
      { kind: 'dirty', id: 'a', label: '' },
    ]),
    ['Git no longer lists it', 'It has uncommitted or untracked files'],
  )
})
