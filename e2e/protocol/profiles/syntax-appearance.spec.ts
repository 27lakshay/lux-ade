import { expect, test } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'

test('syntax bindings persist, resolve independently and reject invalid or stale changes atomically', async ({
  profile,
}) => {
  const initial = await profile.call('settings.appearance', {})
  expect(initial).toMatchObject({ syntax: { binding: { kind: 'follow_app' }, palette: { id: initial.theme_id } } })
  const fixed = await profile.cli(
    'settings',
    'set',
    'syntax_binding',
    JSON.stringify({ kind: 'fixed', theme_id: 'ade:carbon' }),
  )
  expect(fixed.code, fixed.stderr).toBe(0)
  await profile.call('settings.set', { appearance: 'light' })
  const light = await profile.call('settings.appearance', {})
  expect(light).toMatchObject({
    theme_id: 'ade:chalk',
    terminal: { dark: false },
    syntax: {
      palette: { id: 'ade:carbon', mode: 'dark' },
      light_palette: { id: 'ade:carbon', mode: 'dark' },
      dark_palette: { id: 'ade:carbon', mode: 'dark' },
    },
  })
  const paired = { kind: 'paired', light: 'ade:linen', dark: 'ade:ink' }
  expect(
    (
      await rawReply(profile, {
        op: 'settings.set',
        syntax_binding: paired,
        expected_appearance_revision: light.revision,
      })
    ).type,
  ).toBe('settings')
  expect(await profile.call('settings.appearance', {})).toMatchObject({ syntax: { palette: { id: 'ade:linen' } } })
  await profile.call('settings.set', { appearance: 'dark' })
  const current = await profile.call('settings.appearance', {})
  expect(current).toMatchObject({
    syntax: {
      palette: { id: 'ade:ink' },
      light_palette: { id: 'ade:linen', mode: 'light' },
      dark_palette: { id: 'ade:ink', mode: 'dark' },
    },
  })
  for (const binding of [
    { kind: 'fixed', theme_id: 'missing' },
    { kind: 'paired', light: 'ade:carbon', dark: 'ade:ink' },
    { kind: 'unknown' },
  ]) {
    expect((await rawReply(profile, { op: 'settings.set', syntax_binding: binding, appearance: 'light' })).type).toBe(
      'error',
    )
    expect(await profile.call('settings.appearance', {})).toEqual(current)
  }
  expect(
    (
      await rawReply(profile, {
        op: 'settings.set',
        syntax_binding: { kind: 'follow_app' },
        expected_appearance_revision: light.revision,
      })
    ).type,
  ).toBe('error')
  await profile.restartDaemon('kill')
  expect(await profile.call('settings.appearance', {})).toEqual(current)
  await profile.call('settings.appearance.reset', { expected_appearance_revision: current.revision })
  expect(await profile.call('settings.appearance', {})).toMatchObject({
    syntax: { binding: { kind: 'follow_app' }, palette: { id: 'ade:graphite' } },
  })
})
