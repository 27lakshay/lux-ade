// Keybindings (F015; daemon authority decision 7): every app command's key is
// a profile setting in the daemon, so every client binds the same keys. A
// change merges with the other commands, reaches the feed, survives a
// restart and can be reset; an unknown command, a key that is not an
// Electron accelerator, and two commands on one key are refused, and a
// refusal changes nothing.
import { expect, test } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { rawReply } from '../fixtures/raw-reply'
import { defaultKeybindings } from './keybindings'

test('keybindings default, merge a partial change, reach the feed, survive a restart and reset', async ({
  profile,
}) => {
  expect((await profile.call('settings.get', {})).settings.keybindings).toEqual(defaultKeybindings)
  const feed = await subscribeFeed(profile)
  await feed.connected()

  // Setting a subset leaves every other command at its key.
  const set = await profile.call('settings.set', {
    keybindings: { 'new-tab': 'CmdOrCtrl+Shift+T', 'toggle-dev-panel': null },
  })
  const changed = { ...defaultKeybindings, 'new-tab': 'CmdOrCtrl+Shift+T', 'toggle-dev-panel': null }
  expect(set.settings.keybindings).toEqual(changed)
  await feed.waitFor(
    (frame) => frame.type === 'settings_changed' && frame.settings.keybindings['new-tab'] === 'CmdOrCtrl+Shift+T',
  )

  // The CLI binds and unbinds by command ID; other settings keep their values.
  const cli = await profile.cli('settings', 'set', 'keybindings.close-tab', 'none', 'appearance', 'dark')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({
    settings: { appearance: 'dark', keybindings: { ...changed, 'close-tab': null } },
  })

  await profile.restartDaemon('kill')
  const after = await profile.cli('settings', 'get')
  expect(after.json).toMatchObject({ settings: { keybindings: { ...changed, 'close-tab': null } } })

  // Reset one command, then every command.
  const one = await profile.cli('settings', 'reset-keybindings', 'new-tab')
  expect(one.code, one.stderr).toBe(0)
  expect((await profile.call('settings.get', {})).settings.keybindings).toEqual({
    ...defaultKeybindings,
    'toggle-dev-panel': null,
    'close-tab': null,
  })
  const all = await profile.call('settings.set', { reset_keybindings: 'all' })
  expect(all.settings).toEqual({ appearance: 'dark', reduced_motion: 'system', keybindings: defaultKeybindings })
  await feed.waitFor(
    (frame) =>
      frame.type === 'settings_changed' &&
      frame.settings.keybindings['close-tab'] === defaultKeybindings['close-tab'] &&
      frame.settings.keybindings['toggle-dev-panel'] === defaultKeybindings['toggle-dev-panel'],
  )
  // Resetting what is already default changes nothing and sends no frame.
  const frames = feed.frames.length
  await profile.call('settings.set', { reset_keybindings: 'all' })
  await profile.call('settings.get', {})
  expect(feed.frames.slice(frames).filter((frame) => frame.type === 'settings_changed')).toEqual([])
  feed.stop()
})

test('a key two commands would share, a key that is not an accelerator, and an unknown command are refused and change nothing', async ({
  profile,
}) => {
  // CmdOrCtrl+N is Command+N on macOS, so Cmd+N would share it.
  const conflict = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'light',
    keybindings: { 'close-tab': 'Cmd+N' },
  })
  expect(conflict).toMatchObject({
    type: 'error',
    code: 'keybinding_conflict',
    recovery: 'choose_another_key',
    key: 'CmdOrCtrl+N',
    commands: ['new-conversation', 'close-tab'],
  })
  const cli = await profile.cli('settings', 'set', 'keybindings.new-tab', 'ctrl+shift+`')
  expect(cli.code).toBe(33)
  expect(JSON.parse(cli.stderr)).toMatchObject({ code: 'keybinding_conflict', commands: ['new-tab', 'new-terminal'] })

  for (const key of ['Ctrl+', 'Hyper+K', 'Ctrl+Shift', `Ctrl+${'Shift+'.repeat(12)}K`, 'Ctrl+ K']) {
    const invalid = await rawReply(profile, { op: 'settings.set', keybindings: { 'new-tab': key } })
    expect(invalid, key).toMatchObject({ type: 'error', code: 'invalid_keybinding', command: 'new-tab' })
  }
  const invalidCli = await profile.cli('settings', 'set', 'keybindings.new-tab', 'Ctrl++')
  expect(invalidCli.code).toBe(32)

  const unknown = await rawReply(profile, { op: 'settings.set', keybindings: { 'launch-rocket': 'F9' } })
  expect(unknown).toMatchObject({ type: 'error', code: 'unknown_setting' })
  expect(String(unknown.message)).toContain('keybindings.launch-rocket')
  const unknownReset = await rawReply(profile, { op: 'settings.set', reset_keybindings: ['launch-rocket'] })
  expect(unknownReset).toMatchObject({ type: 'error', code: 'unknown_setting' })
  const both = await rawReply(profile, {
    op: 'settings.set',
    keybindings: { 'new-tab': 'F9' },
    reset_keybindings: ['new-tab'],
  })
  expect(both.type).toBe('error')

  // Unbinding one command frees its key for another.
  await profile.call('settings.set', { keybindings: { 'new-conversation': null, 'close-tab': 'CmdOrCtrl+N' } })
  expect((await profile.call('settings.get', {})).settings).toEqual({
    appearance: 'system',
    reduced_motion: 'system',
    keybindings: { ...defaultKeybindings, 'new-conversation': null, 'close-tab': 'CmdOrCtrl+N' },
  })
})
