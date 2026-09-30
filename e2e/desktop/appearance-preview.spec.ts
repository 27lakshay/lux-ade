import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, primaryShell, test } from './fixtures'
import { queryProgram } from '../protocol/fixtures/appearance'
import { replayText, type TerminalFrame } from '../protocol/fixtures/terminals'

async function settings(window: import('@playwright/test').Page) {
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(window.getByRole('button', { name: 'Preview appearance', exact: true })).toBeVisible()
}

test('both-mode preview stays local, preserves native queries and cache, and Escape restores focus', async ({
  profile,
  desktop,
}, testInfo) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { catalog } = await profile.call('catalog.get', {})
  const workspaceId = catalog.workspaces[0]!.id
  const terminalId = await primaryShell(profile, workspaceId)
  for (const id of ['preview-one', 'preview-two']) {
    const created = await profile.cli('window', 'create', workspaceId, '--id', id)
    expect(created.code, created.stderr).toBe(0)
  }
  const { app } = await desktop.launch(profile)
  await expect.poll(() => app.windows().length).toBe(2)
  const [first, second] = app.windows()
  await settings(first!)
  await settings(second!)
  const before = await profile.call('settings.appearance', {})
  const runtime = await profile.call('runtime.status', {})
  const file = join(
    desktop.userData,
    'appearance',
    `${createHash('sha256')
      .update(`socket:${resolve(profile.socket)}`)
      .digest('hex')}.json`,
  )
  await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).appearance.revision).toBe(before.revision)
  const cached = await readFile(file, 'utf8')
  await first!.getByRole('button', { name: 'Preview appearance', exact: true }).click()
  const dialog = first!.getByRole('dialog')
  await dialog.getByLabel('Preview dark palette', { exact: true }).selectOption('ade:carbon')
  await dialog.getByLabel('Preview light palette', { exact: true }).selectOption('ade:linen')
  await expect(dialog.locator('[data-appearance-preview] canvas')).toHaveCount(2)
  await expect(dialog.locator('.shiki')).toHaveCount(2)
  await expect(dialog.locator('[data-appearance-preview="light"] [data-slot="card-title"]')).toHaveCSS(
    'color',
    'rgb(46, 41, 34)',
  )
  await expect(dialog.locator('[data-appearance-preview="dark"] [data-slot="card-title"]')).toHaveCSS(
    'color',
    'rgb(241, 237, 230)',
  )
  await expect(dialog.locator('[data-slot="dialog-title"]')).toHaveCSS('color', 'rgb(236, 238, 242)')
  await expect.poll(() => dialog.locator('diffs-container').count()).toBe(2)
  await expect(dialog.locator('[data-appearance-preview="dark"]')).toHaveCSS('background-color', 'rgb(37, 33, 29)')
  await expect(dialog.locator('[data-appearance-preview="light"]')).toHaveCSS('background-color', 'rgb(252, 250, 245)')
  for (const page of [first!, second!])
    await expect(page.getByRole('main', { name: 'Settings', exact: true, includeHidden: true })).toHaveCSS(
      'background-color',
      'rgb(29, 31, 35)',
    )
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  expect(await readFile(file, 'utf8')).toBe(cached)
  const script = join(profile.root, 'preview-query.py')
  await writeFile(script, queryProgram.replace('APPEARANCE:', 'PREVIEW:'))
  const sent = await profile.cli('terminal', 'send', workspaceId, terminalId, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  const output = async () =>
    replayText((await profile.cli('terminal', 'inspect', workspaceId, terminalId)).json as TerminalFrame)
  await expect.poll(output).toContain('PREVIEW:')
  const reply = Buffer.from((await output()).split('PREVIEW:')[1]!.match(/^[a-f0-9]+/)![0], 'hex').toString()
  expect(reply).toContain('\x1b]11;rgb:1010/1111/1313')
  expect(reply.split('\x1b]11;rgb:')).toHaveLength(2)
  const after = await profile.call('runtime.status', {})
  expect(after.runtime_instance).toBe(runtime.runtime_instance)
  const processes = (value: unknown) =>
    (value as Array<{ workspace: { terminal_id: string }; metrics: { run_id: string; shell_pid: number } }>).map(
      (item) => [item.workspace.terminal_id, item.metrics.run_id, item.metrics.shell_pid],
    )
  const previous = processes(runtime.terminals)
  expect(previous.length).toBeGreaterThan(0)
  for (const [, runId, pid] of previous) {
    expect(runId).toEqual(expect.any(String))
    expect(pid).toEqual(expect.any(Number))
    expect(Number(pid)).toBeGreaterThan(0)
  }
  expect(processes(after.terminals)).toEqual(previous)
  await first!.screenshot({ path: testInfo.outputPath('appearance-preview.png') })
  await first!.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(first!.getByRole('button', { name: 'Preview appearance', exact: true })).toBeFocused()
})

test('preview conflicts retain the draft, rebase explicitly and cancel keeps the newest committed colors', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await settings(window)
  await window.getByRole('button', { name: 'Preview appearance', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByLabel('Preview dark palette', { exact: true }).selectOption('ade:carbon')
  const changed = await profile.cli('settings', 'set', 'app_dark_theme', 'ade:ink')
  expect(changed.code, changed.stderr).toBe(0)
  await expect(window.getByRole('main', { name: 'Settings', exact: true, includeHidden: true })).toHaveCSS(
    'background-color',
    'rgb(29, 28, 33)',
  )
  await dialog.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(dialog.getByText(/changed.*refresh|revision|conflict/i).first()).toBeVisible()
  expect((await profile.call('settings.get', {})).settings.app_dark_theme).toBe('ade:ink')
  await expect(dialog.getByLabel('Preview dark palette', { exact: true })).toHaveValue('ade:carbon')
  await dialog.getByRole('button', { name: 'Cancel preview', exact: true }).click()
  await expect(window.getByRole('main', { name: 'Settings', exact: true, includeHidden: true })).toHaveCSS(
    'background-color',
    'rgb(29, 28, 33)',
  )
  await window.getByRole('button', { name: 'Preview appearance', exact: true }).click()
  await dialog.getByLabel('Preview dark palette', { exact: true }).selectOption('ade:carbon')
  await profile.call('settings.set', { appearance: 'light' })
  await dialog.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Rebase preview', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Rebase preview', exact: true }).click()
  await expect(
    dialog.getByText('Draft retained against the latest saved appearance. Review it before applying.'),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    appearance: 'light',
    app_dark_theme: 'ade:carbon',
  })
})

test('a persistence failure keeps preview and prior settings, and retry commits after recovery', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await settings(window)
  await window.getByRole('button', { name: 'Preview appearance', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByLabel('Preview dark palette', { exact: true }).selectOption('ade:carbon')
  const before = await profile.call('settings.get', {})
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  // Coordinate fixture writes with the live daemon's short transactions.
  database.exec('PRAGMA busy_timeout = 5000')
  try {
    database.exec(
      "CREATE TRIGGER fail_preview_save BEFORE UPDATE ON profile_settings BEGIN SELECT RAISE(ABORT, 'preview persistence failure'); END",
    )
    await dialog.getByRole('button', { name: 'Apply preview', exact: true }).click()
    await expect(dialog.getByText(/preview persistence failure/)).toBeVisible()
    await expect(dialog.getByLabel('Preview dark palette', { exact: true })).toHaveValue('ade:carbon')
    expect(await profile.call('settings.get', {})).toEqual(before)
    database.exec('DROP TRIGGER fail_preview_save')
    await dialog.getByRole('button', { name: 'Apply preview', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect((await profile.call('settings.get', {})).settings.app_dark_theme).toBe('ade:carbon')
  } finally {
    database.close()
  }
})

test('independent terminal and syntax drafts preview both variants and commit atomically', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await settings(window)
  await window.getByRole('button', { name: 'Preview appearance', exact: true }).click()
  const dialog = window.getByRole('dialog')
  const before = (await profile.call('settings.get', {})).settings
  await dialog.getByLabel('Terminal preview mode', { exact: true }).selectOption('fixed')
  await dialog.getByLabel('Terminal fixed preview theme', { exact: true }).selectOption('ade:chalk')
  await dialog.getByLabel('Syntax preview mode', { exact: true }).selectOption('paired')
  await dialog.getByLabel('Syntax light preview theme', { exact: true }).selectOption('ade:linen')
  await dialog.getByLabel('Syntax dark preview theme', { exact: true }).selectOption('ade:ink')
  await expect(dialog.getByText('Terminal: Chalk (light)', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('Code and diff: Linen (light)', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Code and diff: Ink (dark)', { exact: true })).toBeVisible()
  expect((await profile.call('settings.get', {})).settings).toEqual(before)
  await dialog.getByRole('button', { name: 'Apply preview', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    appearance_revision: before.appearance_revision + 1,
    terminal_binding: { kind: 'fixed', theme_id: 'ade:chalk' },
    syntax_binding: { kind: 'paired', light: 'ade:linen', dark: 'ade:ink' },
  })
})
