import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

function fixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'ade-palette-check-'))
  const files = [
    'scripts/generate-theme-css.mjs',
    'crates/ade-core/src/appearance/builtin.json',
    'docs/theme-palette-handoff.md',
    'apps/desktop/src/renderer/src/appearance-defaults.css',
    'apps/desktop/src/shared/app-theme-roles.ts',
  ]
  try {
    for (const name of files) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      copyFileSync(new URL(`../${name}`, import.meta.url), join(root, name))
    }
    const source = join(root, files[1])
    const palettes = JSON.parse(readFileSync(source, 'utf8'))
    mutate?.(palettes)
    writeFileSync(source, JSON.stringify(palettes))
    return spawnSync(process.execPath, [join(root, files[0]), ...(mutate ? [] : ['--check'])], {
      encoding: 'utf8',
      timeout: 5000,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the bundled palettes and generated CSS match the approved handoff', () => {
  const result = fixture()
  assert.equal(result.status, 0, result.stderr)
})

for (const [name, mutate] of [
  [
    'a missing palette',
    (palettes) => {
      delete palettes.midnight
    },
  ],
  [
    'a changed color',
    (palettes) => {
      palettes.graphite.background = '#010203'
    },
  ],
  [
    'a missing role',
    (palettes) => {
      delete palettes.chalk.foreground
    },
  ],
  [
    'an undeclared role',
    (palettes) => {
      palettes.graphite['unowned-role'] = '#010203'
    },
  ],
]) {
  test(`palette generation rejects ${name} before writing CSS`, () => {
    const result = fixture(mutate)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /approved palette handoff/)
  })
}
