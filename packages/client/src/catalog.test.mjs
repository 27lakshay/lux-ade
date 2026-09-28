// Pure-core tests for catalog parsing (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/catalog.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCatalog } from '../dist/index.js'

const workspace = (fields = {}) => ({
  id: 'workspace_1',
  root: '/src/app',
  name: 'app',
  terminal_id: 'terminal_1',
  repository_id: 'repo_1',
  needs_rebind: false,
  worktree_lifecycle_needs_rebind: false,
  ...fields,
})

test('the catalog keeps repositories and each workspace extra terminals', () => {
  const catalog = parseCatalog({
    repositories: [{ id: 'repo_1', root: '/src/app/.git', name: 'app' }],
    workspaces: [workspace({ extra_terminals: ['terminal_2', 'script_build_1'] })],
    conversations: [],
    windows: [],
  })
  assert.deepEqual(catalog.repositories, [{ id: 'repo_1', root: '/src/app/.git', name: 'app' }])
  assert.deepEqual(catalog.workspaces[0].extra_terminals, ['terminal_2', 'script_build_1'])
})

test('an older daemon catalog without them parses with empty lists', () => {
  const catalog = parseCatalog({ workspaces: [workspace()], conversations: [] })
  assert.deepEqual(catalog.repositories, [])
  assert.deepEqual(catalog.workspaces[0].extra_terminals, [])
})

test('a malformed repository or terminal list rejects the catalog', () => {
  assert.equal(parseCatalog({ repositories: [{ id: 'repo_1' }], workspaces: [], conversations: [] }), null)
  assert.equal(parseCatalog({ repositories: {}, workspaces: [], conversations: [] }), null)
  assert.equal(parseCatalog({ workspaces: [workspace({ extra_terminals: [1] })], conversations: [] }), null)
})
