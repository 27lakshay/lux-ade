import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { benchmarkOptions, benchmarkCommand, benchmarkSummary, readBenchmarkNative } from './benchmark-tests.mjs'

const args = ['--suite', 'protocol', '--runs', '3', '--workers', '5', '--prepare', 'existing', '--cache', 'warm']
test('benchmark requires explicit counts and preparation, and preserves representative filters', () => {
  for (const name of ['runs', 'workers', 'prepare', 'cache']) {
    const missing = [...args]
    missing.splice(missing.indexOf(`--${name}`), 2)
    assert.throws(() => benchmarkOptions(missing))
  }
  for (const value of ['0', '-1', '1.5', 'NaN']) assert.throws(() => benchmarkOptions([...args, '--runs', value]))
  const options = benchmarkOptions([...args, '--', '--grep', 'boot | reconnect'])
  assert.deepEqual(benchmarkCommand(options), [
    'pnpm',
    'test:e2e:protocol:only',
    '--workers',
    '5',
    '--grep',
    'boot | reconnect',
  ])
  for (const flag of [
    '--workers=8',
    '--retries',
    '--reporter=json',
    '--retry=2',
    '--list',
    '--config=other.ts',
    '--repeat-each=2',
    '--update-snapshots',
  ])
    assert.throws(() => benchmarkOptions([...args, '--', flag]))
})

test('cold compilation cannot be mistaken for warm correctness measurements', () => {
  assert.throws(() => benchmarkOptions([...args, '--cache', 'cold-build']))
  const cold = [...args, '--suite', 'build-backend', '--cache', 'cold-build']
  assert.equal(benchmarkOptions(cold).cache, 'cold-build')
  assert.throws(() => benchmarkOptions([...cold, '--warmups', '1']))
  assert.throws(() => benchmarkOptions([...cold, '--prepare', 'build']))
})

test('aggregation requires every warmup, measured result and successful native exit', () => {
  const options = { runs: 3, warmups: 1 }
  const native = { results: [{ times: [1, 2, 3], median: 2, min: 1, max: 3, exit_codes: [0, 0, 0] }] }
  const samples = ['warmup-0', '0', '1', '2'].map((iteration) => ({ iteration, status: 'passed' }))
  assert.equal(benchmarkSummary(native, samples, options).status, 'passed')
  assert.equal(benchmarkSummary(null, samples, options).status, 'failed')
  assert.equal(benchmarkSummary(native, samples.slice(1), options).status, 'failed')
  assert.equal(benchmarkSummary(native, [...samples, samples[0]], options).status, 'failed')
  for (const status of ['failed', 'running', 'interrupted'])
    assert.equal(
      benchmarkSummary(
        native,
        samples.map((sample, i) => (i ? sample : { ...sample, status })),
        options,
      ).status,
      'failed',
    )
  for (const exit_codes of [undefined, [0, 1, 0], [0]])
    assert.equal(
      benchmarkSummary({ results: [{ ...native.results[0], exit_codes }] }, samples, options).status,
      'failed',
    )
})

test('aborted Hyperfine exports still produce a terminal failed summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-benchmark-'))
  const file = join(directory, 'hyperfine.json')
  try {
    for (const content of ['', '{']) {
      writeFileSync(file, content)
      assert.equal(
        benchmarkSummary(readBenchmarkNative(file), [{ iteration: '0', status: 'failed' }], { runs: 3, warmups: 0 })
          .status,
        'failed',
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('full acceptance benchmarks preserve both process worker counts and reject subset selection', () => {
  const options = benchmarkOptions([...args, '--suite', 'acceptance'])
  assert.deepEqual(benchmarkCommand(options), ['pnpm', 'test:acceptance', '--workers', '5', '--desktop-workers', '5'])
  assert.throws(() => benchmarkOptions([...args, '--suite', 'acceptance', '--', '--grep', 'boot']))
})
