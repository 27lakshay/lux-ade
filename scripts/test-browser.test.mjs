import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { browserArguments } from './test-browser.mjs'

const cwd = fileURLToPath(new URL('../apps/desktop', import.meta.url))
for (const args of [[], ['--maxWorkers', '3'], ['--maxWorkers=3']]) {
  test(`browser launcher accepts explicit worker selection ${JSON.stringify(args)}`, () => {
    const forwarded = browserArguments(args, '5')
    const result = spawnSync('pnpm', ['exec', 'vitest', '--help', ...forwarded], { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage:/)
    assert.deepEqual(forwarded, args.length ? args : ['--maxWorkers', '5'])
  })
}

test('a package-script separator does not turn report options into file filters', () => {
  const forwarded = browserArguments(['--', 'src/renderer/src/components/kit.test.tsx', '--maxWorkers=1'], '5')
  assert.deepEqual(forwarded, ['src/renderer/src/components/kit.test.tsx', '--maxWorkers=1'])
})
