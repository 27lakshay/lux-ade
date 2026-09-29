// Windows and layouts in the daemon (daemon authority ticket 02): `window.*`
// and `layout.*` through the SDK, the CLI and the feed. The daemon applies
// every layout action with the same core the shared vectors check against the
// desktop reducer, keeps a revision per layout, refuses a stale one, keeps tab
// targets pointing at records that exist, and follows workspace removal.
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallRequest, DailyUseResponse } from '../../../packages/client/dist/index.js'
import { expect, primaryShell, type ScratchProfile, test } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { configureService, nodeService, writeServicePrograms } from '../fixtures/services'
import { TerminalStream } from '../fixtures/terminals'

type LayoutAction = CallRequest<'layout.apply'>['action']
type LayoutNode = DailyUseResponse<'layout.get'>['layout']['layout']['root']
/** What the CLI prints for a window, window list or layout command. */
type CliReply = {
  window: DailyUseResponse<'window.create'>['window']
  windows: DailyUseResponse<'window.list'>['windows']
  layout: DailyUseResponse<'layout.get'>['layout']
}

/** A new plain folder under the test's temp root, opened as a workspace. */
/** Open a new folder as a workspace; `shell` is its primary shell. */
async function workspace(profile: ScratchProfile, name: string) {
  const path = join(profile.root, 'folders', name)
  await mkdir(path, { recursive: true })
  const { workspace } = await profile.call('workspace.open', { path: await realpath(path) })
  return { ...workspace, shell: await primaryShell(profile, workspace.id) }
}

/** The error a rejected SDK call raised, with its daemon code. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string; message: string },
  )
}

/** The tree's shape, as the desktop's `structureKey` writes it. */
function shape(node: LayoutNode): string {
  return node.type === 'pane' ? node.id : `${node.direction}(${node.children.map(shape).join(',')})`
}

function pane(node: LayoutNode, id: string): Extract<LayoutNode, { type: 'pane' }> | undefined {
  if (node.type === 'pane') return node.id === id ? node : undefined
  for (const child of node.children) {
    const found = pane(child, id)
    if (found) return found
  }
  return undefined
}

test('every layout action applies through the SDK, and layout.get reads back each result', async ({ profile }) => {
  const { id: workspaceId, shell: terminalId } = await workspace(profile, 'actions')
  const created = await profile.call('window.create', { window_id: 'w1', workspace_id: workspaceId })
  expect(created.window).toMatchObject({ id: 'w1', workspace_id: workspaceId, state: 'open', bounds: null })
  const fresh = await profile.call('layout.get', { window_id: 'w1' })
  expect(fresh.layout).toMatchObject({ window_id: 'w1', workspace_id: workspaceId, revision: 0 })
  expect(fresh.layout.layout).toMatchObject({
    sidebars: ['navigator', 'inspector'],
    collapsed: { navigator: false, inspector: false },
    widths: { navigator: 260, inspector: 340 },
    tabs: {},
    focused_pane: 'pane-main',
    maximized: null,
  })

  let revision = 0
  const apply = async (action: LayoutAction) => {
    const reply = await profile.call('layout.apply', { window_id: 'w1', action, expected_revision: revision })
    expect(reply.changed, JSON.stringify(action)).toBe(true)
    expect(reply.layout.revision).toBe(revision + 1)
    revision = reply.layout.revision
    expect((await profile.call('layout.get', { window_id: 'w1', workspace_id: workspaceId })).layout).toEqual(
      reply.layout,
    )
    return reply.layout.layout
  }
  const terminal = { kind: 'terminal', id: terminalId } as const
  const fresh1 = { kind: 'new_conversation' } as const

  expect((await apply({ type: 'set_sidebar_sides', left: 'inspector' })).sidebars).toEqual(['inspector', 'navigator'])
  expect((await apply({ type: 'set_side_collapsed', side: 'left', collapsed: true })).collapsed).toEqual({
    navigator: false,
    inspector: true,
  })
  expect((await apply({ type: 'set_collapsed', sidebar: 'inspector', collapsed: false })).collapsed.inspector).toBe(
    false,
  )
  expect((await apply({ type: 'set_width', sidebar: 'navigator', width: 9000 })).widths.navigator).toBe(480)
  await apply({ type: 'open_tab', tab: { id: 'a', target: terminal } })
  await apply({ type: 'open_tab', tab: { id: 'b', target: fresh1 } })
  let layout = await apply({ type: 'open_tab', tab: { id: 'c', target: { kind: 'file', path: 'src/main.rs' } } })
  expect(pane(layout.root, 'pane-main')).toMatchObject({ tabs: ['a', 'b', 'c'], active: 'c' })
  layout = await apply({ type: 'activate_tab', tab_id: 'a' })
  expect(pane(layout.root, 'pane-main')?.active).toBe('a')
  layout = await apply({ type: 'move_tab', tab_id: 'a', pane_id: 'pane-main', index: 3 })
  expect(pane(layout.root, 'pane-main')?.tabs).toEqual(['b', 'c', 'a'])
  layout = await apply({ type: 'drop_tab', tab_id: 'c', pane_id: 'pane-main', zone: 'right', new_pane_id: 'p2' })
  expect(shape(layout.root)).toBe('row(pane-main,p2)')
  expect(layout.focused_pane).toBe('p2')
  layout = await apply({ type: 'split_pane', pane_id: 'p2', direction: 'column', new_pane_id: 'p3' })
  expect(shape(layout.root)).toBe('row(pane-main,column(p2,p3))')
  layout = await apply({ type: 'open_tab', tab: { id: 'd', target: { kind: 'diff', path: 'a.txt', staged: true } } })
  expect(pane(layout.root, 'p3')?.tabs).toEqual(['d'])
  layout = await apply({ type: 'move_pane', pane_id: 'p3', target_id: 'pane-main', zone: 'left' })
  expect(shape(layout.root)).toBe('row(p3,pane-main,p2)')
  layout = await apply({ type: 'swap_panes', pane_id: 'p3', target_id: 'p2' })
  expect(shape(layout.root)).toBe('row(p2,pane-main,p3)')
  layout = await apply({ type: 'dock_pane', pane_id: 'p3', edge: 'bottom' })
  expect(shape(layout.root)).toBe('column(row(p2,pane-main),p3)')
  layout = await apply({ type: 'dock_tab', tab_id: 'b', edge: 'top', new_pane_id: 'p4' })
  expect(shape(layout.root)).toBe('column(p4,row(p2,pane-main),p3)')
  const outer = layout.root.id
  layout = await apply({ type: 'set_split_sizes', split_id: outer, sizes: [20, 50, 30] })
  expect(layout.root).toMatchObject({ sizes: [20, 50, 30] })
  layout = await apply({ type: 'equalize_splits', split_id: outer })
  expect((layout.root as { sizes: number[] }).sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(100)
  layout = await apply({ type: 'focus_pane', pane_id: 'p2' })
  expect(layout.focused_pane).toBe('p2')
  layout = await apply({ type: 'set_maximized', pane_id: 'p2' })
  expect(layout.maximized).toBe('p2')
  layout = await apply({ type: 'close_tab', tab_id: 'd' })
  // Closing p3's only tab removed p3; a tab change keeps p2 maximized.
  expect(shape(layout.root)).toBe('column(p4,row(p2,pane-main))')
  expect(layout.maximized).toBe('p2')
  layout = await apply({ type: 'close_pane', pane_id: 'p4' })
  // Closing a pane rearranges, which restores the grid.
  expect(Object.keys(layout.tabs).sort()).toEqual(['a', 'c'])
  expect(layout.maximized).toBeNull()
  layout = await apply({ type: 'reset_layout' })
  expect(layout).toMatchObject({ sidebars: ['navigator', 'inspector'], widths: { navigator: 260, inspector: 340 } })
  expect(revision).toBe(23)
})

test('the CLI drives windows, tabs and panes, and reads the layout back', async ({ profile }) => {
  const first = await workspace(profile, 'cli-first')
  const second = await workspace(profile, 'cli-second')
  const ok = async (...args: string[]) => {
    const result = await profile.cli(...args)
    expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0)
    return result.json as unknown as CliReply
  }
  expect((await ok('window', 'create', first.id, '--id', 'cli-window')).window).toMatchObject({
    id: 'cli-window',
    workspace_id: first.id,
  })
  expect((await ok('window', 'list')).windows).toHaveLength(1)
  // Commands without --window act on the only open window.
  const opened = await ok('tab', 'open', 'terminal', first.shell, '--id', 'shell')
  expect(opened.layout.revision).toBe(1)
  const split = await ok('pane', 'split', 'pane-main', '--direction', 'row', '--id', 'right')
  expect(shape(split.layout.layout.root)).toBe('row(pane-main,right)')
  await ok('tab', 'open', 'new_conversation', '--pane', 'right', '--id', 'draft')
  await ok('tab', 'open', 'diff', 'README.md', '--staged', '--window', 'cli-window', '--id', 'review')
  const read = await ok('layout', 'get')
  expect(Object.keys(read.layout.layout.tabs).sort()).toEqual(['draft', 'review', 'shell'])
  expect(read.layout.layout.tabs.review?.target).toEqual({ kind: 'diff', path: 'README.md', staged: true })
  // The shell's only tab: tab close ends the shell too, as terminal.close would.
  const closed = await ok('tab', 'close', 'shell')
  expect(closed.layout.layout.tabs.shell).toBeUndefined()
  expect((await profile.call('catalog.get', {})).catalog.terminals.map((t) => t.id)).not.toContain(first.shell)
  const paneClosed = await ok('pane', 'close', 'right')
  // The shell's pane emptied and went; closing the last pane empties it.
  expect((await ok('layout', 'get')).layout.layout.tabs).toEqual({})
  const applied = await ok(
    'layout',
    'apply',
    '--action',
    JSON.stringify({ type: 'set_side_collapsed', side: 'right', collapsed: true }),
    '--expected-revision',
    String(paneClosed.layout.revision),
  )
  expect(applied.layout.layout.collapsed.inspector).toBe(true)
  const stale = await profile.cli(
    'layout',
    'apply',
    '--action',
    JSON.stringify({ type: 'set_sidebar_sides', left: 'inspector' }),
    '--expected-revision',
    '1',
  )
  expect(stale.code).toBe(7)
  expect(stale.json).toMatchObject({ code: 'layout_conflict', recovery: 'reload_layout' })

  // Replacing the whole layout: the default one, as an import would.
  const replaced = await ok(
    'layout',
    'replace',
    '--layout',
    JSON.stringify({
      ...read.layout.layout,
      tabs: {},
      root: { type: 'pane', id: 'only', tabs: [], active: null },
      focused_pane: 'only',
      maximized: null,
    }),
  )
  expect(shape(replaced.layout.layout.root)).toBe('only')

  // Window state.
  expect((await ok('window', 'show', 'cli-window', second.id)).window).toMatchObject({
    workspace_id: second.id,
    view: { recent_workspaces: [second.id, first.id] },
  })
  // The first workspace's layout is kept while the window shows the second.
  expect((await ok('layout', 'get', '--workspace', first.id)).layout.layout.root.id).toBe('only')
  expect((await ok('layout', 'get')).layout.revision).toBe(0)
  expect((await ok('window', 'bounds', 'cli-window', '10', '20', '1280', '800')).window).toMatchObject({
    bounds: { x: 10, y: 20, width: 1280, height: 800 },
  })
  expect((await ok('window', 'collapse', 'cli-window', 'project-a', 'project-b')).window).toMatchObject({
    view: { collapsed_projects: ['project-a', 'project-b'] },
  })
  expect((await ok('window', 'close', 'cli-window')).window).toMatchObject({ state: 'closed' })
  // No open window is left to act on by default.
  const none = await profile.cli('layout', 'get')
  expect(none.code).toBe(2)
  expect((await ok('window', 'reopen', 'cli-window')).window).toMatchObject({
    state: 'open',
    bounds: { width: 1280 },
  })
})

test('a replayed layout.apply keeps its revision, and a stale expected_revision is refused as a conflict', async ({
  profile,
}) => {
  const { id: workspaceId, shell: terminalId } = await workspace(profile, 'replay')
  await profile.call('window.create', { window_id: 'w', workspace_id: workspaceId })
  // A command that names its new tab or pane: the retry finds it made.
  const open = {
    window_id: 'w',
    action: { type: 'open_tab', tab: { id: 't', target: { kind: 'terminal', id: terminalId } } },
  } as const
  const first = await profile.call('layout.apply', open)
  const again = await profile.call('layout.apply', open)
  expect(again.layout).toEqual(first.layout)
  expect(again.changed).toBe(false)
  const split = {
    window_id: 'w',
    action: { type: 'split_pane', pane_id: 'pane-main', direction: 'row', new_pane_id: 'p2' },
  } as const
  const splitOnce = await profile.call('layout.apply', split)
  expect((await profile.call('layout.apply', split)).layout.revision).toBe(splitOnce.layout.revision)

  // A state change names the state it sets: a replay without a revision changes nothing.
  const collapse = { window_id: 'w', action: { type: 'set_side_collapsed', side: 'left', collapsed: true } } as const
  const collapsed = await profile.call('layout.apply', collapse)
  expect(collapsed.layout.layout.collapsed.navigator).toBe(true)
  const replayed = await profile.call('layout.apply', collapse)
  expect(replayed).toMatchObject({ changed: false, layout: collapsed.layout })

  // Swapping panes is relative to where they are, so it needs a revision...
  const unrevised = await refusal(
    profile.call('layout.apply', {
      window_id: 'w',
      action: { type: 'swap_panes', pane_id: 'pane-main', target_id: 'p2' },
    }),
  )
  expect(unrevised.code).toBe('invalid_layout')
  // ...and a retry from the same revision returns the first result, not a second swap.
  const toggle = {
    window_id: 'w',
    action: { type: 'swap_panes', pane_id: 'pane-main', target_id: 'p2' },
    expected_revision: collapsed.layout.revision,
  } as const
  const toggled = await profile.call('layout.apply', toggle)
  expect(shape(toggled.layout.layout.root)).toBe('row(p2,pane-main)')
  const retried = await profile.call('layout.apply', toggle)
  expect(retried.layout).toEqual(toggled.layout)
  expect(retried.changed).toBe(true)

  // Any other write from that stale revision is a conflict, and changes nothing.
  const stale = await refusal(
    profile.call('layout.apply', {
      window_id: 'w',
      action: { type: 'set_sidebar_sides', left: 'inspector' },
      expected_revision: collapsed.layout.revision,
    }),
  )
  expect(stale.code).toBe('layout_conflict')
  const replaced = await refusal(
    profile.call('layout.replace', {
      window_id: 'w',
      layout: splitOnce.layout.layout,
      expected_revision: 1,
    }),
  )
  expect(replaced.code).toBe('layout_conflict')
  expect((await profile.call('layout.get', { window_id: 'w' })).layout).toEqual(toggled.layout)
})

test('windows and layouts survive a daemon restart', async ({ profile }) => {
  const { id: workspaceId, shell: terminalId } = await workspace(profile, 'restart')
  await profile.call('window.create', {
    window_id: 'kept',
    workspace_id: workspaceId,
    bounds: { x: 1, y: 2, width: 900, height: 700 },
  })
  await profile.call('layout.apply', {
    window_id: 'kept',
    action: { type: 'open_tab', tab: { id: 'shell', target: { kind: 'terminal', id: terminalId } } },
  })
  const before = await profile.call('layout.apply', {
    window_id: 'kept',
    action: { type: 'split_pane', pane_id: 'pane-main', direction: 'column', new_pane_id: 'below' },
  })
  await profile.call('window.close', { window_id: 'kept' })
  await profile.restartDaemon('kill')
  const { windows } = await profile.call('window.list', {})
  expect(windows).toEqual([
    {
      id: 'kept',
      workspace_id: workspaceId,
      state: 'closed',
      bounds: { x: 1, y: 2, width: 900, height: 700 },
      view: { collapsed_projects: [], recent_workspaces: [workspaceId] },
      layouts: { [workspaceId]: 2 },
    },
  ])
  expect((await profile.call('layout.get', { window_id: 'kept' })).layout).toEqual(before.layout)
  // The catalog snapshot carries the windows too.
  expect((await profile.call('catalog.get', {})).catalog.windows).toEqual(windows)
})

test('removing a workspace deletes its layouts and moves its windows, and the feed reports both', async ({
  profile,
}) => {
  const removed = await workspace(profile, 'zeta')
  const next = await workspace(profile, 'alpha')
  await profile.call('window.create', { window_id: 'moving', workspace_id: removed.id })
  await profile.call('layout.apply', {
    window_id: 'moving',
    action: { type: 'open_tab', tab: { id: 'shell', target: { kind: 'terminal', id: removed.shell } } },
  })
  const feed = await subscribeFeed(profile)
  await feed.connected()
  await profile.call('workspace.remove', { operation_id: 'remove-zeta', workspace_id: removed.id })
  await feed.waitFor(
    (frame) => frame.type === 'layout_removed' && frame.window_id === 'moving' && frame.workspace_id === removed.id,
  )
  const moved = await feed.waitFor((frame) => frame.type === 'window_changed' && frame.window.id === 'moving')
  expect(moved).toMatchObject({ window: { workspace_id: next.id, state: 'open', layouts: {} } })
  // The layout the window now shows arrives too, so a client need not ask.
  const shown = await feed.waitFor(
    (frame) =>
      frame.type === 'layout_changed' && frame.layout.window_id === 'moving' && frame.layout.workspace_id === next.id,
  )
  expect(shown).toMatchObject({ layout: { revision: 0 } })
  feed.stop()
  // A retry of the window's creation, whose workspace is gone, returns the window.
  expect((await profile.call('window.create', { window_id: 'moving', workspace_id: removed.id })).window).toMatchObject(
    { id: 'moving', workspace_id: next.id },
  )
  const { windows } = await profile.call('window.list', {})
  expect(windows[0]).toMatchObject({ workspace_id: next.id, view: { recent_workspaces: [next.id] } })
  expect((await refusal(profile.call('layout.get', { window_id: 'moving', workspace_id: removed.id }))).code).toBe(
    'workspace_removed',
  )
  // The window now shows the other workspace's default layout.
  expect((await profile.call('layout.get', { window_id: 'moving' })).layout).toMatchObject({
    workspace_id: next.id,
    revision: 0,
  })
})

test('a layout change reaches a feed subscriber with its revision', async ({ profile }) => {
  const { id: workspaceId } = await workspace(profile, 'feed')
  const feed = await subscribeFeed(profile)
  await feed.connected()
  await profile.call('window.create', { window_id: 'watched', workspace_id: workspaceId })
  await feed.waitFor((frame) => frame.type === 'window_changed' && frame.window.id === 'watched')
  await profile.call('layout.apply', {
    window_id: 'watched',
    action: { type: 'set_sidebar_sides', left: 'inspector' },
  })
  const changed = await feed.waitFor((frame) => frame.type === 'layout_changed' && frame.layout.window_id === 'watched')
  expect(changed).toMatchObject({ layout: { revision: 1, layout: { sidebars: ['inspector', 'navigator'] } } })
  // A change that changes nothing publishes nothing and keeps the revision.
  const count = feed.frames.length
  const same = await profile.call('layout.apply', {
    window_id: 'watched',
    action: { type: 'focus_pane', pane_id: 'pane-main' },
  })
  expect(same).toMatchObject({ changed: false, layout: { revision: 1 } })
  await profile.call('window.set_bounds', { window_id: 'watched', bounds: { x: 0, y: 0, width: 800, height: 600 } })
  await feed.waitFor((frame) => frame.type === 'window_changed' && frame.window.bounds !== null)
  expect(feed.frames.slice(count).map((frame) => frame.type)).toEqual(['window_changed'])
  feed.stop()
})

test('refuses a missing tab target, an unknown window, a reused window ID and malformed input', async ({ profile }) => {
  const { id: workspaceId } = await workspace(profile, 'refusals')
  const other = await workspace(profile, 'refusals-other')
  await profile.call('window.create', { window_id: 'w', workspace_id: workspaceId })
  // Creating it again on the same workspace returns it; on another it is refused.
  expect((await profile.call('window.create', { window_id: 'w', workspace_id: workspaceId })).window.id).toBe('w')
  expect((await refusal(profile.call('window.create', { window_id: 'w', workspace_id: other.id }))).code).toBe(
    'window_exists',
  )
  for (const target of [
    { kind: 'conversation', id: 'conversation_missing' },
    { kind: 'terminal', id: 'terminal_missing' },
  ] as const) {
    const refused = await refusal(
      profile.call('layout.apply', { window_id: 'w', action: { type: 'open_tab', tab: { id: 't', target } } }),
    )
    expect(refused.code, target.kind).toBe('tab_target_missing')
  }
  expect((await refusal(profile.call('layout.get', { window_id: 'nowhere' }))).code).toBe('window_not_found')
  expect(
    (await refusal(profile.call('window.show_workspace', { window_id: 'w', workspace_id: 'workspace_missing' }))).code,
  ).toBe('workspace_not_found')
  const malformedActions: LayoutAction[] = [
    { type: 'set_split_sizes', split_id: 's', sizes: [30, 30] },
    { type: 'open_tab', tab: { id: 'f', target: { kind: 'file', path: '../outside' } } },
    { type: 'focus_pane', pane_id: '' },
  ]
  for (const action of malformedActions) {
    expect((await refusal(profile.call('layout.apply', { window_id: 'w', action }))).code).toBe('invalid_layout')
  }
  const malformed = await refusal(
    profile.call('window.set_bounds', { window_id: 'w', bounds: { x: 0, y: 0, width: 0, height: 10 } }),
  )
  expect(malformed.code).toBe('invalid_layout')
  expect((await profile.call('layout.get', { window_id: 'w' })).layout.revision).toBe(0)
})

test('terminal.create with place opens its tab, and terminal.close removes that tab from every layout', async ({
  profile,
}) => {
  const { id: workspaceId } = await workspace(profile, 'placed')
  for (const window of ['left', 'right']) {
    await profile.call('window.create', { window_id: window, workspace_id: workspaceId })
  }
  const split = await profile.call('layout.apply', {
    window_id: 'left',
    action: { type: 'split_pane', pane_id: 'pane-main', direction: 'row', new_pane_id: 'side' },
  })
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const { terminal_id: terminalId } = await profile.call('terminal.create', {
    workspace_id: workspaceId,
    operation_id: 'placed-terminal',
    place: { window_id: 'left', pane_id: 'pane-main' },
  })
  const placed = await feed.waitFor((frame) => frame.type === 'layout_changed' && frame.layout.window_id === 'left')
  expect(placed).toMatchObject({ layout: { revision: split.layout.revision + 1 } })
  const tabId = `tab-${terminalId}`
  let left = (await profile.call('layout.get', { window_id: 'left' })).layout.layout
  expect(left.tabs[tabId]?.target).toEqual({ kind: 'terminal', id: terminalId })
  expect(pane(left.root, 'pane-main')).toMatchObject({ tabs: [tabId], active: tabId })
  // A retry of the creation returns the same terminal and places nothing again.
  const retried = await profile.call('terminal.create', {
    workspace_id: workspaceId,
    operation_id: 'placed-terminal',
    place: { window_id: 'left', pane_id: 'pane-main' },
  })
  expect(retried.terminal_id).toBe(terminalId)
  expect((await profile.call('layout.get', { window_id: 'left' })).layout.revision).toBe(split.layout.revision + 1)
  // Another window shows the same terminal in a tab of its own.
  await profile.call('layout.apply', {
    window_id: 'right',
    action: { type: 'open_tab', tab: { id: 'mirror', target: { kind: 'terminal', id: terminalId } } },
  })

  await profile.call('terminal.close', { operation_id: 'close-placed', terminal_id: terminalId })
  for (const window of ['left', 'right']) {
    await feed.waitFor(
      (frame) =>
        frame.type === 'layout_changed' &&
        frame.layout.window_id === window &&
        Object.keys(frame.layout.layout.tabs).length === 0,
    )
    expect((await profile.call('layout.get', { window_id: window })).layout.layout.tabs).toEqual({})
  }
  feed.stop()
  // The emptied pane left the split; the other pane stays.
  left = (await profile.call('layout.get', { window_id: 'left' })).layout.layout
  expect(shape(left.root)).toBe('side')
  // A closed terminal cannot be shown again.
  const refused = await refusal(
    profile.call('layout.apply', {
      window_id: 'right',
      action: { type: 'open_tab', tab: { id: 'late', target: { kind: 'terminal', id: terminalId } } },
    }),
  )
  expect(refused.code).toBe('tab_target_missing')
})

/** The terminal records the catalog lists for a workspace, by ID. */
async function terminalIds(profile: ScratchProfile, workspaceId: string): Promise<string[]> {
  return (await profile.call('catalog.get', {})).catalog.terminals
    .filter((terminal) => terminal.workspace_id === workspaceId)
    .map((terminal) => terminal.id)
}

test('tab.close and pane.close end the shells whose last tab they remove; a busy one refuses until forced', async ({
  profile,
}) => {
  const { id: workspaceId } = await workspace(profile, 'decision-5')
  await profile.call('window.create', { window_id: 'w', workspace_id: workspaceId })
  const place = { window_id: 'w', pane_id: 'pane-main' }
  const { terminal_id: idle } = await profile.call('terminal.create', { workspace_id: workspaceId, place })
  const { terminal_id: busy } = await profile.call('terminal.create', { workspace_id: workspaceId, place })
  await profile.call('layout.apply', {
    window_id: 'w',
    action: { type: 'open_tab', tab: { id: 'notes', target: { kind: 'file', path: 'notes.md' } } },
  })
  const streams = [idle, busy].map((id) => TerminalStream.open(profile, workspaceId, id))
  const runId = (await streams[1]!.snapshot()).run_id as string
  await streams[0]!.snapshot()
  streams[1]!.send({ op: 'input', run_id: runId, data: 'sleep 30\n' })
  await expect
    .poll(async () => (await profile.call('catalog.get', {})).catalog.terminals.find((t) => t.id === busy)?.busy)
    .toBe(true)
  const before = (await profile.call('layout.get', { window_id: 'w' })).layout

  // layout.apply never ends a process: removing a running shell's last tab needs tab.close.
  const required = (await profile
    .call('layout.apply', { window_id: 'w', action: { type: 'close_pane', pane_id: 'pane-main' } })
    .then(
      () => {
        throw new Error('The close was expected to be refused')
      },
      (failure: unknown) => failure,
    )) as { code: string; details: { tabs?: string[] } }
  expect(required.code).toBe('tab_close_required')
  expect(required.details.tabs?.sort()).toEqual([`tab-${busy}`, `tab-${idle}`].sort())

  // Closing the pane would end both shells; the busy one refuses and nothing closes.
  const refused = (await profile
    .call('pane.close', { operation_id: 'close-pane-1', window_id: 'w', pane_id: 'pane-main' })
    .then(
      () => {
        throw new Error('The close was expected to be refused')
      },
      (failure: unknown) => failure,
    )) as { code: string; details: { terminals?: Array<{ terminal_id: string; foreground: string | null }> } }
  expect(refused.code).toBe('terminal_busy')
  expect(refused.details.terminals).toEqual([{ terminal_id: busy, foreground: 'sleep' }])
  expect(await terminalIds(profile, workspaceId)).toEqual(expect.arrayContaining([idle, busy]))
  expect((await profile.call('layout.get', { window_id: 'w' })).layout).toEqual(before)

  // Closing the idle shell's tab ends the shell; a retry returns the recorded outcome.
  const close = { operation_id: 'close-idle', window_id: 'w', tab_id: `tab-${idle}` }
  const closedIdle = await profile.call('tab.close', close)
  expect(Object.keys(closedIdle.layout.layout.tabs).sort()).toEqual(['notes', `tab-${busy}`])
  expect(await terminalIds(profile, workspaceId)).not.toContain(idle)
  expect(await profile.call('tab.close', close)).toEqual(closedIdle)

  // Forced, closing the pane stops the busy shell too; the file tab just leaves.
  const forced = await profile.call('pane.close', {
    operation_id: 'close-pane-2',
    window_id: 'w',
    pane_id: 'pane-main',
    force: true,
  })
  expect(forced.layout.layout.tabs).toEqual({})
  expect(await terminalIds(profile, workspaceId)).not.toContain(busy)
  for (const stream of streams) stream.close()
})

test('a shell shown in two windows closes only with its last tab', async ({ profile }) => {
  const { id: workspaceId } = await workspace(profile, 'two-windows')
  for (const window of ['a', 'b']) await profile.call('window.create', { window_id: window, workspace_id: workspaceId })
  const { terminal_id: shell } = await profile.call('terminal.create', {
    workspace_id: workspaceId,
    place: { window_id: 'a' },
  })
  await profile.call('layout.apply', {
    window_id: 'b',
    action: { type: 'open_tab', tab: { id: 'mirror', target: { kind: 'terminal', id: shell } } },
  })
  await profile.call('tab.close', { operation_id: 'close-a', window_id: 'a', tab_id: `tab-${shell}` })
  expect(await terminalIds(profile, workspaceId)).toContain(shell)
  expect(Object.keys((await profile.call('layout.get', { window_id: 'b' })).layout.layout.tabs)).toEqual(['mirror'])
  await profile.call('tab.close', { operation_id: 'close-b', window_id: 'b', tab_id: 'mirror' })
  expect(await terminalIds(profile, workspaceId)).not.toContain(shell)
})

test('tab.close ends a shell in a workspace that needs rebind', async ({ profile }) => {
  const path = join(profile.root, 'folders', 'moved')
  await mkdir(path, { recursive: true })
  const { workspace: moved } = await profile.call('workspace.open', { path: await realpath(path) })
  await profile.call('window.create', { window_id: 'w', workspace_id: moved.id })
  const { terminal_id: shell } = await profile.call('terminal.create', {
    workspace_id: moved.id,
    place: { window_id: 'w' },
  })
  // The saved folder is replaced by another directory at the same path.
  await rm(path, { recursive: true })
  await mkdir(path)
  expect((await refusal(profile.call('file.list', { workspace_id: moved.id }))).code).toBe('needs_rebind')
  const closed = await profile.call('tab.close', {
    operation_id: 'close-moved',
    window_id: 'w',
    tab_id: `tab-${shell}`,
  })
  expect(closed.layout.layout.tabs).toEqual({})
  expect(await terminalIds(profile, moved.id)).not.toContain(shell)
})

test('removing a service, or the workspace of a shown terminal, publishes the layouts that lost its tabs', async ({
  profile,
  repo,
}) => {
  const { workspace: home } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, home.id, 'web', nodeService(files.server))
  const started = await profile.call('service.start', { workspace_id: home.id, name: 'web' })
  await profile.call('service.stop', { workspace_id: home.id, name: 'web' })
  const other = await workspace(profile, 'elsewhere')
  await profile.call('window.create', { window_id: 'w', workspace_id: home.id })
  await profile.call('layout.apply', {
    window_id: 'w',
    action: { type: 'open_tab', tab: { id: 'logs', target: { kind: 'terminal', id: started.terminal_id! } } },
  })
  // A window on another workspace shows the home workspace's shell.
  await profile.call('window.create', { window_id: 'v', workspace_id: other.id })
  await profile.call('layout.apply', {
    window_id: 'v',
    action: {
      type: 'open_tab',
      tab: { id: 'remote', target: { kind: 'terminal', id: await primaryShell(profile, home.id) } },
    },
  })
  const feed = await subscribeFeed(profile)
  await feed.connected()

  await profile.call('service.remove', { workspace_id: home.id, name: 'web', revision: 1 })
  const lostLogs = await feed.waitFor((frame) => frame.type === 'layout_changed' && frame.layout.window_id === 'w')
  expect(lostLogs).toMatchObject({ layout: { layout: { tabs: {} } } })

  await profile.call('workspace.remove', { operation_id: 'remove-home', workspace_id: home.id })
  const lostShell = await feed.waitFor((frame) => frame.type === 'layout_changed' && frame.layout.window_id === 'v')
  expect(lostShell).toMatchObject({ layout: { workspace_id: other.id, layout: { tabs: {} } } })
  feed.stop()
})
