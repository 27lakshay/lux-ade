// Pure-core tests for catalog parsing (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/catalog.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyWindowFrame, parseCatalog } from '../dist/index.js'

const workspace = (fields = {}) => ({
  id: 'workspace_1',
  root: '/src/app',
  name: 'app',
  project_id: 'repo_1',
  kind: 'primary_checkout',
  branch: 'main',
  default: false,
  ade_owned: false,
  needs_rebind: false,
  worktree_lifecycle_needs_rebind: false,
  ...fields,
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
  ...fields,
})

const conversation = (fields = {}) => ({
  id: 'conversation_1',
  workspace_id: 'workspace_1',
  title: 'Fix the build',
  provider: 'codex',
  status: 'running',
  account_id: null,
  account_context: 'managed',
  attention: 'running',
  unread: false,
  parent_conversation_id: null,
  group_id: null,
  ...fields,
})

const window = (fields = {}) => ({
  id: 'window_1',
  workspace_id: 'workspace_1',
  state: 'open',
  bounds: null,
  view: { collapsed_projects: [], recent_workspaces: ['workspace_1'] },
  layouts: { workspace_1: 3 },
  ...fields,
})

/** A catalog as the daemon sends it, with `fields` replacing its lists. */
const catalog = (fields = {}) => ({
  projects: [{ id: 'repo_1', kind: 'repository', name: 'app', root: '/src/app/.git' }],
  workspaces: [workspace()],
  conversations: [conversation()],
  terminals: [terminal()],
  windows: [window()],
  ...fields,
})

test('the catalog keeps projects, workspace facts, terminals, conversation attention and windows', () => {
  const parsed = parseCatalog(
    catalog({
      projects: [
        { id: 'repo_1', kind: 'repository', name: 'app', root: '/src/app/.git' },
        { id: 'project_2', kind: 'folder', name: 'notes', root: '/src/notes' },
      ],
      workspaces: [workspace({ kind: 'linked_worktree', branch: 'feature', ade_owned: true })],
      conversations: [conversation({ attention: 'needs_you', unread: true, parent_conversation_id: 'conversation_0' })],
      windows: [window({ bounds: { x: 0, y: 20, width: 1200, height: 800 } })],
    }),
  )
  assert.deepEqual(parsed.projects[1], { id: 'project_2', kind: 'folder', name: 'notes', root: '/src/notes' })
  assert.deepEqual(parsed.workspaces, [workspace({ kind: 'linked_worktree', branch: 'feature', ade_owned: true })])
  assert.deepEqual(parsed.terminals, [terminal()])
  assert.deepEqual(parsed.conversations, [
    conversation({ attention: 'needs_you', unread: true, parent_conversation_id: 'conversation_0' }),
  ])
  assert.deepEqual(parsed.windows, [window({ bounds: { x: 0, y: 20, width: 1200, height: 800 } })])
  const exited = parseCatalog(catalog({ terminals: [terminal({ status: 'exited', exit_code: 2, busy: false })] }))
  assert.equal(exited.terminals[0].exit_code, 2)
})

test('an unknown terminal kind or status is kept as sent', () => {
  const parsed = parseCatalog(catalog({ terminals: [terminal({ kind: 'pty', status: 'paused' })] }))
  assert.equal(parsed.terminals[0].kind, 'pty')
  assert.equal(parsed.terminals[0].status, 'paused')
})

test('a missing list or any malformed record rejects the catalog', () => {
  for (const list of ['projects', 'workspaces', 'conversations', 'terminals', 'windows']) {
    const missing = catalog()
    delete missing[list]
    assert.equal(parseCatalog(missing), null, `without ${list}`)
    assert.equal(parseCatalog(catalog({ [list]: {} })), null, `${list} not a list`)
  }
  const malformed = [
    { projects: [{ id: 'p', kind: 'club', name: 'n', root: '/' }] },
    { workspaces: [workspace({ kind: 'bare' })] },
    { workspaces: [workspace({ branch: 3 })] },
    { workspaces: [workspace({ project_id: undefined })] },
    { workspaces: [workspace({ needs_rebind: undefined })] },
    { conversations: [conversation({ attention: 'busy' })] },
    { conversations: [conversation({ attention: undefined })] },
    { conversations: [conversation({ group_id: 7 })] },
    { conversations: [conversation({ account_context: undefined })] },
    { terminals: [terminal({ kind: 3 })] },
    { terminals: [terminal({ status: null })] },
    { terminals: [terminal({ exit_code: 'one' })] },
    { terminals: [terminal({ busy: 'yes' })] },
    { terminals: [terminal({ primary: undefined })] },
    { terminals: [terminal({ foreground: 3 })] },
    { terminals: [terminal({ title: undefined })] },
    { terminals: [terminal({ id: '' })] },
    { windows: [window({ state: 'hidden' })] },
    { windows: [window({ layouts: { a: -1 } })] },
    { windows: [window({ layouts: undefined })] },
  ]
  for (const fields of malformed) assert.equal(parseCatalog(catalog(fields)), null, JSON.stringify(fields))
})

test('window and layout frames keep the windows and their layout revisions current', () => {
  const windows = [window()]
  const moved = applyWindowFrame(windows, { type: 'window_changed', window: window({ workspace_id: 'workspace_2' }) })
  assert.equal(moved[0].workspace_id, 'workspace_2')
  const added = applyWindowFrame(windows, { type: 'window_changed', window: window({ id: 'window_2' }) })
  assert.deepEqual(
    added.map((item) => item.id),
    ['window_1', 'window_2'],
  )
  const layout = (revision, workspace_id = 'workspace_1') => ({
    type: 'layout_changed',
    layout: { window_id: 'window_1', workspace_id, revision, layout: {} },
  })
  assert.deepEqual(applyWindowFrame(windows, layout(4))[0].layouts, { workspace_1: 4 })
  // An older revision, arriving late, never lowers the one held.
  assert.deepEqual(applyWindowFrame(windows, layout(2))[0].layouts, { workspace_1: 3 })
  assert.deepEqual(applyWindowFrame(windows, layout(1, 'workspace_2'))[0].layouts, { workspace_1: 3, workspace_2: 1 })
  const removed = applyWindowFrame(windows, {
    type: 'layout_removed',
    window_id: 'window_1',
    workspace_id: 'workspace_1',
  })
  assert.deepEqual(removed[0].layouts, {})
  assert.equal(applyWindowFrame(windows, { type: 'window_changed', window: { id: 'x' } }), null)
  assert.equal(applyWindowFrame(windows, { type: 'conversation_changed' }), undefined)
})
