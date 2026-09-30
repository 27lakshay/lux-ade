import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, primaryShell, test } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'
import { subscribeFeed } from '../fixtures/feed'
import { configureService, nodeService, writeServicePrograms } from '../fixtures/services'

function source(id = 'user:remove', mode = 'light') {
  const defaults = mode === 'light' ? 'ade:chalk' : 'ade:graphite'
  return JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id,
    name: 'Removal fixture',
    mode,
    provenance: { kind: 'user' },
    app: { defaults, tokens: { primary: '#123456' } },
    terminal: { defaults, tokens: { 'terminal-foreground': '#123456' } },
    syntax: { defaults, tokens: {} },
  })
}

test('removal discloses direct and followed selections and atomically applies same-mode fallbacks', async ({
  profile,
}) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  await profile.call('settings.set', {
    appearance: 'dark',
    app_light_theme: 'user:remove',
    terminal_binding: { kind: 'fixed', theme_id: 'user:remove' },
    syntax_binding: { kind: 'follow_app' },
    terminal_minimum_contrast: 4.5,
    terminal_bold_color: 'bright',
    reduced_motion: 'on',
  })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const before = (await profile.call('settings.get', {})).settings
  await profile.call('terminal.appearance.set', {
    workspace_id: workspace.id,
    terminal_id: terminalId,
    expected_appearance_revision: before.appearance_revision,
    binding: { kind: 'paired', light: 'user:remove', dark: 'ade:carbon' },
  })
  const current = (await profile.call('settings.get', {})).settings
  const raw = await rawReply(profile, { op: 'themes.removal', id: 'user:remove' })
  expect(raw.type).toBe('theme_removal_plan')
  const plan = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  expect(plan).toMatchObject({
    removable: true,
    appearance_revision: current.appearance_revision,
    total: 4,
    next_key: null,
  })
  expect(plan.impacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ consumer: 'app', slot: 'light', fallback_id: 'ade:chalk', indirect: false }),
      expect.objectContaining({ consumer: 'terminal', slot: 'fixed', fallback_id: 'ade:chalk', indirect: false }),
      expect.objectContaining({ consumer: 'syntax', slot: 'light', fallback_id: 'ade:chalk', indirect: true }),
      expect.objectContaining({
        consumer: 'terminal',
        terminal_id: terminalId,
        workspace_id: workspace.id,
        slot: 'light',
        fallback_id: 'ade:chalk',
      }),
    ]),
  )
  const cliPlan = await profile.cli('themes', 'removal', 'user:remove')
  expect(cliPlan.code, cliPlan.stderr).toBe(0)
  expect(cliPlan.json).toEqual(plan)
  const feed = await subscribeFeed(profile)
  await feed.connected()
  try {
    const removed = await profile.cli(
      'themes',
      'remove',
      'user:remove',
      String(plan.theme.revision),
      String(plan.appearance_revision),
    )
    expect(removed.code, removed.stderr).toBe(0)
    expect(removed.json).toMatchObject({
      type: 'theme_removal',
      id: 'user:remove',
      changed: true,
      revision: 2,
      appearance_revision: plan.appearance_revision + 1,
    })
    const after = (await profile.call('settings.get', {})).settings
    expect(after).toEqual({
      ...current,
      appearance_revision: current.appearance_revision + 1,
      app_light_theme: 'ade:chalk',
      terminal_binding: { kind: 'fixed', theme_id: 'ade:chalk' },
    })
    const terminal = await profile.call('terminal.appearance.get', {
      workspace_id: workspace.id,
      terminal_id: terminalId,
    })
    expect(terminal.binding).toEqual({ kind: 'paired', light: 'ade:chalk', dark: 'ade:carbon' })
    await feed.waitFor((frame) => frame.type === 'theme_library_changed' && frame.library_revision === 2)
    await feed.waitFor(
      (frame) => frame.type === 'settings_changed' && frame.settings.appearance_revision === after.appearance_revision,
    )
    expect((await rawReply(profile, { op: 'themes.inspect', id: 'user:remove' })).code).toBe('theme_not_found')
    expect(
      await profile.call('themes.remove', {
        id: 'user:remove',
        expected_revision: 1,
        expected_appearance_revision: plan.appearance_revision,
      }),
    ).toMatchObject({ changed: false, revision: 2 })
    expect(feed.frames.filter((frame) => frame.type === 'theme_library_changed')).toHaveLength(1)
    await profile.restartDaemon('kill')
    expect((await profile.call('settings.get', {})).settings).toEqual(after)
  } finally {
    feed.stop()
  }
})

test('stale removal revisions and persistence failure leave definitions and selections intact', async ({ profile }) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  const plan = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  await profile.call('themes.rename', { id: 'user:remove', name: 'Edited elsewhere', expected_revision: 1 })
  expect(
    await rawReply(profile, {
      op: 'themes.remove',
      id: 'user:remove',
      expected_revision: 1,
      expected_appearance_revision: plan.appearance_revision,
    }),
  ).toMatchObject({ code: 'theme_conflict', expected: 1, current: 2 })
  const second = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:remove' } })
  expect(
    await rawReply(profile, {
      op: 'themes.remove',
      id: 'user:remove',
      expected_revision: 2,
      expected_appearance_revision: second.appearance_revision,
    }),
  ).toMatchObject({ code: 'appearance_conflict' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  await profile.call('terminal.appearance.set', {
    workspace_id: workspace.id,
    terminal_id: terminalId,
    expected_appearance_revision: (await profile.call('settings.get', {})).settings.appearance_revision,
    binding: { kind: 'fixed', theme_id: 'user:remove' },
  })
  const terminalBefore = await profile.call('terminal.appearance.get', {
    workspace_id: workspace.id,
    terminal_id: terminalId,
  })
  const latest = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  const settings = await profile.call('settings.get', {})
  const inspected = await profile.call('themes.inspect', { id: 'user:remove' })
  const library = await profile.call('themes.list', {})
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  try {
    database.exec(
      "CREATE TRIGGER fail_remove BEFORE UPDATE ON profile_settings WHEN NEW.key='appearance_revision' BEGIN SELECT RAISE(ABORT,'removal persistence failure'); END",
    )
    const failed = await rawReply(profile, {
      op: 'themes.remove',
      id: 'user:remove',
      expected_revision: 2,
      expected_appearance_revision: latest.appearance_revision,
    })
    expect(failed.message).toContain('removal persistence failure')
    expect(await profile.call('themes.inspect', { id: 'user:remove' })).toEqual(inspected)
    expect(await profile.call('themes.list', {})).toEqual(library)
    expect(await profile.call('settings.get', {})).toEqual(settings)
    expect(
      await profile.call('terminal.appearance.get', { workspace_id: workspace.id, terminal_id: terminalId }),
    ).toEqual(terminalBefore)
    database.exec('DROP TRIGGER fail_remove')
    expect(
      await profile.call('themes.remove', {
        id: 'user:remove',
        expected_revision: 2,
        expected_appearance_revision: latest.appearance_revision,
      }),
    ).toMatchObject({ changed: true, revision: 3 })
  } finally {
    database.close()
  }
})

test('removal impact pagination covers every terminal override and concurrent replacement cannot be deleted with an old plan', async ({
  profile,
}) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const ids = []
  for (let index = 0; index < 20; index++) {
    const { terminal_id } = await profile.call('terminal.create', { workspace_id: workspace.id })
    ids.push(terminal_id)
    await profile.call('terminal.appearance.set', {
      workspace_id: workspace.id,
      terminal_id,
      expected_appearance_revision: (await profile.call('settings.get', {})).settings.appearance_revision,
      binding: { kind: 'fixed', theme_id: 'user:remove' },
    })
  }
  expect((await profile.call('settings.appearance', {})).propagation.state).toBe('applied')
  const first = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  expect(first.total).toBe(20)
  expect(first.impacts).toHaveLength(16)
  const second = await profile.call('themes.removal', { id: 'user:remove', after_key: first.next_key })
  expect(second.impacts).toHaveLength(4)
  expect(second.next_key).toBeNull()
  expect(new Set([...first.impacts, ...second.impacts].map((impact) => impact.terminal_id))).toEqual(new Set(ids))
  const replies = await Promise.all([
    rawReply(profile, {
      op: 'themes.remove',
      id: 'user:remove',
      expected_revision: 1,
      expected_appearance_revision: first.appearance_revision,
    }),
    rawReply(profile, { op: 'themes.rename', id: 'user:remove', name: 'Competing replacement', expected_revision: 1 }),
  ])
  expect(replies.filter((reply) => reply.type !== 'error')).toHaveLength(1)
  expect(replies.filter((reply) => reply.type === 'error')).toHaveLength(1)
  expect(['theme_conflict', 'theme_not_found']).toContain(replies.find((reply) => reply.type === 'error')!.code)
  const listing = await profile.call('themes.list', {})
  expect(listing.revision).toBe(2)
})

test('removal updates a retained service terminal before its workspace is reopened', async ({ profile, repo }) => {
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'retained', nodeService(files.server))
  const service = await profile.call('service.start', { workspace_id: workspace.id, name: 'retained' })
  const terminalId = service.terminal_id!
  await profile.call('terminal.appearance.set', {
    workspace_id: workspace.id,
    terminal_id: terminalId,
    expected_appearance_revision: (await profile.call('settings.get', {})).settings.appearance_revision,
    binding: { kind: 'fixed', theme_id: 'user:remove' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'retained' })
  await profile.call('workspace.remove', { workspace_id: workspace.id })
  const plan = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  expect(plan.total).toBe(1)
  expect(plan.impacts[0]).toMatchObject({ terminal_id: terminalId, fallback_id: 'ade:chalk' })
  await profile.call('themes.remove', {
    id: 'user:remove',
    expected_revision: plan.theme.revision,
    expected_appearance_revision: plan.appearance_revision,
  })
  await profile.restartDaemon('kill')
  const reopened = await profile.call('workspace.open', { path: repo.path })
  expect(reopened.workspace.id).toBe(workspace.id)
  expect(
    (await profile.call('terminal.appearance.get', { workspace_id: workspace.id, terminal_id: terminalId })).binding,
  ).toEqual({ kind: 'fixed', theme_id: 'ade:chalk' })
})

test('bundled removal is protected, unselected deletion leaves appearance intact and recreated IDs reject an old removal', async ({
  profile,
}) => {
  const core = await profile.call('themes.removal', { id: 'ade:chalk', after_key: null })
  expect(core.removable).toBe(false)
  expect(
    await rawReply(profile, {
      op: 'themes.remove',
      id: 'ade:chalk',
      expected_revision: 0,
      expected_appearance_revision: core.appearance_revision,
    }),
  ).toMatchObject({ code: 'theme_protected' })
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  const before = await profile.call('settings.appearance', {})
  const plan = await profile.call('themes.removal', { id: 'user:remove', after_key: null })
  expect(plan.total).toBe(0)
  await profile.call('themes.remove', {
    id: 'user:remove',
    expected_revision: 1,
    expected_appearance_revision: plan.appearance_revision,
  })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  expect(
    await rawReply(profile, {
      op: 'themes.remove',
      id: 'user:remove',
      expected_revision: 1,
      expected_appearance_revision: plan.appearance_revision,
    }),
  ).toMatchObject({ code: 'theme_conflict', current: 3 })
})
