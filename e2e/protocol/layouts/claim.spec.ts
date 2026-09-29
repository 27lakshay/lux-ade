// `window.claim` (daemon authority ticket 08): a UI window with no record gets
// one in a single command. The daemon picks an open window the caller does
// not show yet, else reopens the last closed one, else makes a new one on the
// first listed workspace; the desktop no longer lists windows and chooses.
import { expect, test } from '../fixtures'

test('window.claim hands out open, then closed, then new windows, and a repeat returns the same one', async ({
  profile,
}) => {
  const { catalog } = await profile.call('catalog.get', {})
  const first = catalog.workspaces[0]!.id

  // No window yet: a new one on the first listed workspace, under the caller's ID.
  const made = await profile.call('window.claim', { window_id: 'claim-a' })
  expect(made.window).toMatchObject({ id: 'claim-a', workspace_id: first, state: 'open' })
  expect((await profile.call('window.claim', { window_id: 'claim-a' })).window).toEqual(made.window)

  // An open window the caller does not show yet is handed out before anything is made.
  expect((await profile.call('window.claim', { window_id: 'claim-unused' })).window.id).toBe('claim-a')
  // Claimed already: the next caller gets a new window.
  const second = await profile.call('window.claim', { window_id: 'claim-b', claimed: ['claim-a'] })
  expect(second.window).toMatchObject({ id: 'claim-b', state: 'open' })

  // With none open, a closed window comes back: the last created first.
  await profile.call('window.close', { window_id: 'claim-a' })
  await profile.call('window.close', { window_id: 'claim-b' })
  const reopened = await profile.call('window.claim', { window_id: 'claim-c' })
  expect(reopened.window).toMatchObject({ id: 'claim-b', state: 'open' })
  // A repeat finds it open and unclaimed.
  expect((await profile.call('window.claim', { window_id: 'claim-c' })).window.id).toBe('claim-b')
  const next = await profile.call('window.claim', { window_id: 'claim-c', claimed: ['claim-b'] })
  expect(next.window).toMatchObject({ id: 'claim-a', state: 'open' })
  expect((await profile.call('window.list', {})).windows.map((window) => window.id)).toEqual(['claim-a', 'claim-b'])

  // The CLI makes the same claim.
  const cli = await profile.cli('window', 'claim', 'claim-cli', 'claim-a', 'claim-b')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ type: 'window', window: { id: 'claim-cli', workspace_id: first, state: 'open' } })
  expect((await profile.cli('window', 'claim')).code).toBe(2)
})
