import { expect, test } from '../fixtures'
import { startBrowserOwner } from '../fixtures/browser-owner'
import { rawReply } from '../fixtures/raw-reply'

test('only the current desktop owner can advance system appearance; observations survive headless restart', async ({
  profile,
}) => {
  const owner = await startBrowserOwner(profile, () => ({}))
  const observe = (sequence: number, mode: 'light' | 'dark', ownerId = owner.ownerId) =>
    rawReply(profile, {
      op: 'settings.appearance.observe',
      profile_id: owner.profileId,
      owner_id: ownerId,
      sequence,
      mode,
    })
  try {
    expect((await profile.call('settings.appearance', {})).mode).toBe('dark')
    expect((await observe(1, 'light', 'unregistered-viewer')).type).toBe('error')
    expect((await observe(1, 'light')).type).toBe('settings')
    const light = await profile.call('settings.appearance', {})
    expect(light).toMatchObject({
      mode: 'light',
      theme_id: 'ade:chalk',
      revision: 1,
      propagation: { state: 'applied' },
    })
    expect((await observe(1, 'light')).type).toBe('settings')
    expect((await profile.call('settings.appearance', {})).revision).toBe(1)
    expect((await observe(0, 'dark')).type).toBe('error')
    expect((await observe(1, 'dark')).type).toBe('error')
    await owner.register()
    expect((await observe(0, 'dark')).type).toBe('error')
    await profile.call('settings.set', { appearance: 'dark' })
    const explicit = await profile.call('settings.appearance', {})
    expect((await observe(2, 'dark')).type).toBe('settings')
    expect((await observe(3, 'light')).type).toBe('settings')
    expect(await profile.call('settings.appearance', {})).toEqual(explicit)
    await profile.call('settings.set', { appearance: 'system' })
    expect((await profile.call('settings.appearance', {})).mode).toBe('light')
    await profile.restartDaemon('kill')
    expect((await profile.call('settings.appearance', {})).mode).toBe('light')
    expect((await observe(4, 'dark')).type).toBe('error')
    await owner.register()
    expect((await observe(4, 'dark')).type).toBe('settings')
    expect((await profile.call('settings.appearance', {})).mode).toBe('dark')
  } finally {
    await owner.close()
  }
})
