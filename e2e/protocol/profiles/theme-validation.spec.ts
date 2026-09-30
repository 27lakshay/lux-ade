import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'

const definition = {
  format: 'ade-theme',
  version: 1,
  id: 'user:sample',
  name: 'Sample',
  mode: 'dark',
  provenance: { kind: 'user' },
  app: { defaults: 'ade:graphite', tokens: { primary: '#AbC' } },
}

test('SDK and CLI validation agree, diagnose malformed definitions and leave committed appearance unchanged', async ({
  profile,
}) => {
  const before = await profile.call('settings.appearance', {})
  const source = `// JSONC\n${JSON.stringify(definition, null, 2)}`
  const result = await profile.call('themes.validate', { source })
  expect(result).toMatchObject({
    type: 'theme_validation',
    valid: true,
    definition: { id: 'user:sample', app: { tokens: { primary: '#aabbcc', base: '#101113' } } },
  })
  const normalized = result.diagnostics.find((diagnostic) => diagnostic.code === 'normalized')!
  expect(source.slice(normalized.offset, normalized.offset + normalized.length)).toBe('"#AbC"')
  expect(normalized.line).toBeGreaterThan(1)
  const file = join(profile.root, 'theme.jsonc')
  await writeFile(file, source)
  const valid = await profile.cli('themes', 'validate', file)
  expect(valid.code, valid.stderr).toBe(0)
  expect(valid.json).toEqual(result)
  for (const bad of [
    source.replace('"version": 1', '"version": 2'),
    source.replace('"#AbC"', '"var(--primary)"'),
    '{"version":1,"version":2}',
    '',
  ]) {
    await writeFile(file, bad)
    const sdk = await profile.call('themes.validate', { source: bad })
    const cli = await profile.cli('themes', 'validate', file)
    expect(sdk).toMatchObject({ valid: false, definition: null })
    expect(cli.code).toBe(2)
    expect(cli.json).toEqual(sdk)
    expect(sdk.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
  }
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await profile.restartDaemon('kill')
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})
