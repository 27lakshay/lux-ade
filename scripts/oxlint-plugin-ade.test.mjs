// Runs each rule in oxlint-plugin-ade.mjs through the real oxlint binary against small fixtures.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const oxlint = join(root, 'node_modules/.bin/oxlint')
const plugin = join(root, 'scripts/oxlint-plugin-ade.mjs')

function lint(rule, source, file = 'fixture.ts') {
  const directory = mkdtempSync(join(tmpdir(), 'ade-oxlint-rule-'))
  try {
    writeFileSync(join(directory, file), source)
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        jsPlugins: [plugin],
        categories: { correctness: 'off' },
        rules: { [`ade/${rule}`]: 'error' },
      }),
    )
    const result = spawnSync(oxlint, ['-c', 'config.json', file], { cwd: directory, encoding: 'utf8' })
    return { failed: result.status !== 0, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const valid = (rule, name, source, file) =>
  test(`${rule}: ${name}`, () => {
    const { failed, output } = lint(rule, source, file)
    assert.equal(failed, false, output)
  })
const invalid = (rule, name, source, message, file) =>
  test(`${rule}: ${name}`, () => {
    const { failed, output } = lint(rule, source, file)
    assert.equal(failed, true, 'expected the rule to report')
    assert.match(output, message)
  })

const safe = 'contextIsolation: true, sandbox: true, nodeIntegration: false'

valid(
  'electron-web-preferences',
  'allows a window that states every setting',
  `new BrowserWindow({ width: 800, webPreferences: { preload: 'p.cjs', ${safe} } })`,
)
valid(
  'electron-web-preferences',
  'allows a view that also turns webSecurity on',
  `new WebContentsView({ webPreferences: { ${safe}, webSecurity: true, webviewTag: false } })`,
)
valid('electron-web-preferences', 'ignores other constructors', 'new Map([[1, 2]])')
invalid(
  'electron-web-preferences',
  'reports a window without webPreferences',
  'new BrowserWindow({ width: 800 })',
  /needs a webPreferences object literal/,
)
invalid(
  'electron-web-preferences',
  'reports options passed as a variable',
  'const options = {}; new BrowserWindow(options)',
  /object literal with webPreferences/,
)
invalid(
  'electron-web-preferences',
  'reports sandbox turned off',
  'new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false } })',
  /must state sandbox: true/,
)
invalid(
  'electron-web-preferences',
  'reports a missing contextIsolation',
  'new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false } })',
  /must state contextIsolation: true/,
)
invalid(
  'electron-web-preferences',
  'reports nodeIntegration computed at runtime',
  'const on = true; new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: on } })',
  /must state nodeIntegration: false/,
)
invalid(
  'electron-web-preferences',
  'reports webSecurity turned off',
  `new BrowserWindow({ webPreferences: { ${safe}, webSecurity: false } })`,
  /must not set webSecurity/,
)
invalid(
  'electron-web-preferences',
  'reports the webview tag turned on',
  `new BrowserWindow({ webPreferences: { ${safe}, webviewTag: true } })`,
  /must not set webviewTag/,
)
invalid(
  'electron-web-preferences',
  'reports a spread into webPreferences',
  `const extra = {}; new BrowserWindow({ webPreferences: { ${safe}, ...extra } })`,
  /Do not spread/,
)

valid('require-store-selector', 'allows useStore with a selector', 'useStore(store, (state) => state.status)')
valid('require-store-selector', 'allows useDaemon with a selector', 'useDaemon((state) => state.workspaces.w1)')
valid('require-store-selector', 'ignores other calls', 'useState(0)')
invalid('require-store-selector', 'reports useStore without a selector', 'useStore(store)', /without a selector/)
invalid('require-store-selector', 'reports useDaemon without a selector', 'useDaemon()', /without a selector/)

valid('no-loose-record', 'allows a record of a named type', 'type Counts = Record<string, number>')
valid('no-loose-record', 'allows a contract type', "type Reply = DailyUseResponse<'file.list'>")
invalid(
  'no-loose-record',
  'reports Record<string, unknown>',
  'type Frame = Record<string, unknown>',
  /drops the contract/,
)
invalid(
  'no-loose-record',
  'reports Record<string, any> in a method signature',
  'interface Bridge { request(fields: Record<string, any>): Promise<void> }',
  /drops the contract/,
)

valid('no-native-title', 'allows a title prop on a component', '<CommandDialog title="Commands" />', 'fixture.tsx')
valid('no-native-title', 'allows an aria-label', '<button aria-label="Close" />', 'fixture.tsx')
invalid(
  'no-native-title',
  'reports title on an HTML element',
  '<button title="Close" />',
  /native title/,
  'fixture.tsx',
)
invalid('no-native-title', 'reports title on an SVG element', '<svg title="Logo" />', /native title/, 'fixture.tsx')
