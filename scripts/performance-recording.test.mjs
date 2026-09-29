import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { performanceOptions } from './test-performance.mjs'
import { PerformanceSamples } from '../e2e/protocol/fixtures/performance-recording.ts'

test('performance evidence retains earlier and failed observations before final reporting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-performance-'))
  try {
    const file = join(directory, 'raw.json')
    const samples = new PerformanceSamples(file, { mode: 'latency' })
    assert.equal(await samples.measure('ready', async () => 42), 42)
    const failure = new Error('readiness failed')
    await assert.rejects(
      samples.measure('startup', async () => {
        throw failure
      }),
      (error) => error === failure,
    )
    const journal = readFileSync(`${file}.jsonl`, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(
      journal.filter((sample) => sample.type === 'sample').map((sample) => [sample.name, sample.status]),
      [
        ['ready', 'passed'],
        ['startup', 'failed'],
      ],
    )
    assert.ok(
      journal
        .filter((sample) => sample.type === 'sample')
        .every((sample) => Number.isFinite(sample.ms) && sample.ms >= 0),
    )
    void samples.measure('unfinished', () => new Promise(() => {}))
    samples.finish('failed', ['readiness failed'])
    const report = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(report.status, 'failed')
    assert.equal(report.samples.length, 2)
    assert.equal(report.incompleteSamples[0].name, 'unfinished')
    assert.equal(report.incompleteSamples[0].status, 'incomplete')
    assert.ok(report.incompleteSamples[0].elapsedMs >= 0)
    assert.deepEqual(report.errors, ['readiness failed'])
    assert.throws(() => new PerformanceSamples(file, {}), /EEXIST/)
    assert.throws(() => samples.record({ name: 'invalid', ms: NaN, status: 'passed' }), /Invalid/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('performance command fixes worker count and rejects correctness retries and arbitrary configuration', () => {
  assert.deepEqual(performanceOptions(['--grep', 'startup', '--diagnostics', '--workers', '1']), {
    diagnostics: true,
    list: false,
    filters: ['--grep', '(?=.*@load)(?:startup)'],
  })
  for (const args of [
    ['--workers', '2'],
    ['--retries', '1'],
    ['--config', 'other.ts'],
    ['--grep'],
    ['--repeat-each', '3'],
  ])
    assert.throws(() => performanceOptions(args))
})

test(
  'performance listing selects a workload without building or requiring execution evidence',
  { timeout: 15000 },
  () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const result = spawnSync(process.execPath, ['scripts/test-performance.mjs', '--list', '--grep', 'startup:'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /Total: 1 test in 1 file/)
    assert.match(result.stdout, /startup: five fresh profiles/)
    assert.doesNotMatch(result.stdout, /debug backend build/)
  },
)
