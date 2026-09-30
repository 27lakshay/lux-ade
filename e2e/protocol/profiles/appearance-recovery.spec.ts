import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, test } from '../fixtures'

test('missing, wrong-mode and malformed palette selections fall back and remain resettable', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'dark', reduced_motion: 'on' })
  for (const stored of [JSON.stringify('missing:palette'), JSON.stringify('ade:chalk'), '{invalid']) {
    const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
    database
      .prepare(
        "INSERT INTO profile_settings(key,value,updated_at) VALUES('app_dark_theme',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(stored)
    database.close()
    await profile.restartDaemon('kill')
    const appearance = await profile.call('settings.appearance', {})
    expect(appearance).toMatchObject({ theme_id: 'ade:graphite', mode: 'dark', propagation: { state: 'applied' } })
    expect(appearance.diagnostics).toHaveLength(1)
    expect(appearance.diagnostics[0]).toMatchObject({ slot: 'dark', fallback_id: 'ade:graphite' })
    const reset = await profile.call('settings.appearance.reset', { expected_appearance_revision: appearance.revision })
    expect(reset.settings.reduced_motion).toBe('on')
    expect(reset.settings.appearance_revision).toBeGreaterThan(appearance.revision)
    expect((await profile.call('settings.appearance', {})).diagnostics).toEqual([])
    await profile.call('settings.set', { appearance: 'dark' })
  }
})
