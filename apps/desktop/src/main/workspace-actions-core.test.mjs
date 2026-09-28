// In-process tests for the workspace removal wording (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/workspace-actions-core.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceBlockerText, worktreeBlockerTexts } from './workspace-actions-core.ts'

test('workspace blockers name what is running', () => {
  assert.equal(
    workspaceBlockerText({ kind: 'conversation_running', id: 'c', label: 'Fix the build' }),
    '“Fix the build” is running',
  )
  assert.equal(
    workspaceBlockerText({ kind: 'service_running', id: 's', label: 'Service web' }),
    'Service web is running',
  )
  assert.equal(
    workspaceBlockerText({ kind: 'default_workspace', id: 'w', label: "The daemon's default workspace" }),
    'ADE keeps this workspace for itself',
  )
  assert.equal(workspaceBlockerText({ kind: 'something_new', id: 'x', label: 'Thing x' }), 'Thing x')
})

test('a worktree held only by its own workspace can be deleted', () => {
  assert.deepEqual(worktreeBlockerTexts({ blockers: [] }), [])
  assert.deepEqual(worktreeBlockerTexts({ blockers: ['active_work', 'setup_incomplete'] }), [])
})

test('other worktree blockers are listed once each', () => {
  assert.deepEqual(worktreeBlockerTexts({ blockers: ['dirty', 'active_work', 'unavailable', 'not_listed'] }), [
    'It has uncommitted or untracked files',
    'Git no longer lists it',
  ])
  assert.deepEqual(worktreeBlockerTexts({ blockers: ['brand_new'] }), ['Blocked: brand new'])
})

test('a tree the plan leaves out is the main checkout', () => {
  assert.deepEqual(worktreeBlockerTexts(undefined), ['It is the project’s main checkout'])
})
