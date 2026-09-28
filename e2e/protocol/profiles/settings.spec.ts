// Profile settings (daemon authority ticket 03; F013, F014): appearance and
// reduced motion live in the profile daemon, so every client applies the
// same preferences. A change reaches the feed; an unknown key is refused.
import { expect, test } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { rawReply } from '../fixtures/raw-reply'

test('settings default, change through the CLI, reach the feed and survive a restart', async ({ profile }) => {
  expect(await profile.call('settings.get', {})).toEqual({
    type: 'settings',
    settings: { appearance: 'system', reduced_motion: 'system' },
  })
  const feed = await subscribeFeed(profile)
  await feed.connected()

  const set = await profile.cli('settings', 'set', 'appearance', 'dark', 'reduced_motion', 'on')
  expect(set.code, set.stderr).toBe(0)
  expect(set.json).toEqual({ type: 'settings', settings: { appearance: 'dark', reduced_motion: 'on' } })
  await feed.waitFor(
    (frame) =>
      frame.type === 'settings_changed' &&
      frame.settings.appearance === 'dark' &&
      frame.settings.reduced_motion === 'on',
  )
  feed.stop()

  // One key changes alone; the other keeps its value.
  expect((await profile.call('settings.set', { appearance: 'light' })).settings).toEqual({
    appearance: 'light',
    reduced_motion: 'on',
  })
  await profile.restartDaemon('kill')
  const got = await profile.cli('settings', 'get')
  expect(got.json).toEqual({ type: 'settings', settings: { appearance: 'light', reduced_motion: 'on' } })
})

test('an unknown key or value is refused and changes nothing', async ({ profile }) => {
  const unknown = await rawReply(profile, { op: 'settings.set', appearance: 'dark', colour: 'red' })
  expect(unknown).toMatchObject({ type: 'error', code: 'unknown_setting' })
  expect(String(unknown.message)).toContain('colour')
  const invalid = await rawReply(profile, { op: 'settings.set', appearance: 'sepia' })
  expect(invalid.type).toBe('error')
  // The SDK and the CLI refuse an unknown key before sending it.
  const cli = await profile.cli('settings', 'set', 'colour', 'red')
  expect(cli.code).not.toBe(0)
  expect((await profile.call('settings.get', {})).settings).toEqual({ appearance: 'system', reduced_motion: 'system' })
})
