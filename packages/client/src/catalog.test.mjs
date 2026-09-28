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

const terminal = (fields = {}) => ({
  id: 'terminal_1',
  workspace_id: 'workspace_1',
  kind: 'shell',
  title: 'zsh',
  status: 'running',
  exit_code: null,
  busy: true,
  foreground: 'sleep',
  primary: true,
  service_id: null,
  script_run_id: null,
  conversation_id: null,
  ...fields,
})

test('the catalog keeps terminal records, and an older daemon lists none', () => {
  const catalog = parseCatalog({ workspaces: [workspace()], conversations: [], terminals: [terminal()] })
  assert.deepEqual(catalog.terminals, [terminal()])
  assert.deepEqual(parseCatalog({ workspaces: [workspace()], conversations: [] }).terminals, [])
  const exited = parseCatalog({
    workspaces: [workspace()],
    conversations: [],
    terminals: [{ id: 't', workspace_id: 'w', kind: 'script', title: 'build', status: 'exited', exit_code: 2 }],
  }).terminals[0]
  assert.equal(exited.exit_code, 2)
  assert.equal(exited.busy, false)
  assert.equal(exited.script_run_id, null)
})

test('a malformed terminal record rejects the catalog', () => {
  for (const bad of [
    terminal({ kind: 'pty' }),
    terminal({ status: 'busy' }),
    terminal({ exit_code: 'one' }),
    terminal({ busy: 'yes' }),
    terminal({ foreground: 3 }),
    terminal({ title: undefined }),
  ]) {
    assert.equal(parseCatalog({ workspaces: [], conversations: [], terminals: [bad] }), null)
  }
  assert.equal(parseCatalog({ workspaces: [], conversations: [], terminals: {} }), null)
})
