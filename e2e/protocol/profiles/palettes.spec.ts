import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'
import { rawReply } from '../fixtures/raw-reply'

test('the public palette catalog preserves every approved palette, mode and role', async ({ profile }) => {
  const result = await rawReply(profile, { op: 'settings.palettes' })
  expect(result.type).toBe('palettes')
  const handoff = readFileSync(join(repositoryRoot, 'docs/theme-palette-handoff.md'), 'utf8')
  const expected = [...handoff.matchAll(/^### (\w+) — (dark|light)\n[\s\S]*?```css\n([\s\S]*?)```/gm)].map(
    ([, name, mode, block]) => ({
      id: `ade:${name!.toLowerCase()}`,
      name,
      mode,
      tokens: Object.fromEntries(
        [...block!.matchAll(/--([a-z0-9-]+):\s*(#[\da-fA-F]{6}(?:[\da-fA-F]{2})?);/g)].map(([, role, value]) => [
          role,
          value,
        ]),
      ),
    }),
  )
  expect(expected).toHaveLength(12)
  for (const palette of expected) expect(Object.keys(palette.tokens)).toHaveLength(73)
  expect(result.palettes).toEqual(expected)
  expect(await profile.call('settings.palettes', {})).toEqual(result)
  const cli = await profile.cli('settings', 'palettes')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(result)
})

test('palette slots validate mode, persist both choices and resolve their catalog identities', async ({ profile }) => {
  const initial = await profile.call('settings.get', {})
  expect(initial.settings).toMatchObject({ app_light_theme: 'ade:chalk', app_dark_theme: 'ade:graphite' })
  const set = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'dark',
    app_light_theme: 'ade:linen',
    app_dark_theme: 'ade:carbon',
    expected_appearance_revision: 0,
  })
  expect(set.type).toBe('settings')
  expect(set.settings).toMatchObject({
    appearance_revision: 1,
    app_light_theme: 'ade:linen',
    app_dark_theme: 'ade:carbon',
  })
  const dark = await profile.call('settings.appearance', {})
  const catalog = await profile.call('settings.palettes', {})
  expect(dark).toMatchObject({ theme_id: 'ade:carbon', revision: 1, propagation: { state: 'applied' } })
  expect(dark.tokens).toEqual(catalog.palettes.find((palette) => palette.id === dark.theme_id)!.tokens)
  for (const id of ['ade:chalk', 'missing:theme']) {
    const rejected = await rawReply(profile, { op: 'settings.set', app_dark_theme: id, reduced_motion: 'on' })
    expect(rejected.type).toBe('error')
    expect((await profile.call('settings.get', {})).settings).toEqual(set.settings)
  }
  const light = await profile.cli('settings', 'set', 'appearance', 'light', 'expected_appearance_revision', '1')
  expect(light.code, light.stderr).toBe(0)
  await profile.restartDaemon('kill')
  const restored = await profile.call('settings.appearance', {})
  expect(restored).toMatchObject({ theme_id: 'ade:linen', revision: 2, propagation: { state: 'applied' } })
  expect(restored.tokens).toEqual(catalog.palettes.find((palette) => palette.id === restored.theme_id)!.tokens)
  const reset = await profile.call('settings.appearance.reset', { expected_appearance_revision: 2 })
  expect(reset.settings).toMatchObject({
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    appearance_revision: 3,
  })
})
