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

test('an unknown terminal kind or status is kept as sent', () => {
  const catalog = parseCatalog({
    workspaces: [],
    conversations: [],
    terminals: [terminal({ kind: 'pty', status: 'paused' })],
  })
  assert.equal(catalog.terminals[0].kind, 'pty')
  assert.equal(catalog.terminals[0].status, 'paused')
})

test('a malformed terminal record is dropped alone, keeping the catalog', () => {
  for (const bad of [
    terminal({ kind: 3 }),
    terminal({ status: null }),
    terminal({ exit_code: 'one' }),
    terminal({ busy: 'yes' }),
    terminal({ foreground: 3 }),
    terminal({ title: undefined }),
    terminal({ id: '' }),
  ]) {
    const catalog = parseCatalog({ workspaces: [workspace()], conversations: [], terminals: [bad, terminal()] })
    assert.deepEqual(catalog.terminals, [terminal()])
    assert.equal(catalog.workspaces.length, 1)
  }
  assert.equal(parseCatalog({ workspaces: [], conversations: [], terminals: {} }), null)
})

const conversation = (fields = {}) => ({
  id: 'conversation_1',
  workspace_id: 'workspace_1',
  title: 'Fix the build',
  provider: 'codex',
  status: 'running',
  ...fields,
})

test('the catalog keeps projects, workspace facts and conversation attention', () => {
  const catalog = parseCatalog({
    projects: [
      { id: 'repo_1', kind: 'repository', name: 'app', root: '/src/app/.git' },
      { id: 'project_2', kind: 'folder', name: 'notes', root: '/src/notes' },
    ],
    repositories: [{ id: 'repo_1', root: '/src/app/.git', name: 'app' }],
    workspaces: [
      workspace({
        project_id: 'repo_1',
        kind: 'linked_worktree',
        branch: 'feature',
        default: false,
        ade_owned: true,
      }),
    ],
    conversations: [
      conversation({ attention: 'needs_you', unread: true, parent_conversation_id: 'conversation_0', group_id: null }),
    ],
  })
  assert.equal(catalog.projects.length, 2)
  assert.deepEqual(catalog.projects[1], { id: 'project_2', kind: 'folder', name: 'notes', root: '/src/notes' })
  const [listed] = catalog.workspaces
  assert.equal(listed.project_id, 'repo_1')
  assert.equal(listed.kind, 'linked_worktree')
  assert.equal(listed.branch, 'feature')
  assert.equal(listed.ade_owned, true)
  // The deprecated alias stays.
  assert.equal(listed.repository_id, 'repo_1')
  assert.deepEqual(catalog.conversations[0], {
    ...conversation(),
    attention: 'needs_you',
    unread: true,
    parent_conversation_id: 'conversation_0',
    group_id: null,
  })
})

test('an older daemon catalog gets projects from its repositories and plain folders', () => {
  const catalog = parseCatalog({
    repositories: [{ id: 'repo_1', root: '/src/app/.git', name: 'app' }],
    workspaces: [workspace(), workspace({ id: 'workspace_2', root: '/src/notes/', repository_id: null })],
    conversations: [conversation()],
  })
  assert.deepEqual(catalog.projects, [
    { id: 'repo_1', kind: 'repository', name: 'app', root: '/src/app/.git' },
    { id: 'workspace_2', kind: 'folder', name: 'notes', root: '/src/notes/' },
  ])
  assert.equal(catalog.workspaces[0].kind, 'primary_checkout')
  assert.equal(catalog.workspaces[1].kind, 'folder')
  assert.equal(catalog.workspaces[1].project_id, 'workspace_2')
  assert.equal(catalog.workspaces[0].branch, null)
  // Without attention the conversation carries only what the daemon sent.
  assert.deepEqual(catalog.conversations[0], conversation())
})

test('a malformed project, kind or attention rejects the catalog', () => {
  const base = { workspaces: [], conversations: [] }
  assert.equal(parseCatalog({ ...base, projects: [{ id: 'p', kind: 'club', name: 'n', root: '/' }] }), null)
  assert.equal(parseCatalog({ ...base, projects: {} }), null)
  assert.equal(parseCatalog({ workspaces: [workspace({ kind: 'bare' })], conversations: [] }), null)
  assert.equal(parseCatalog({ workspaces: [workspace({ branch: 3 })], conversations: [] }), null)
  assert.equal(parseCatalog({ workspaces: [], conversations: [conversation({ attention: 'busy' })] }), null)
  assert.equal(parseCatalog({ workspaces: [], conversations: [conversation({ group_id: 7 })] }), null)
})
