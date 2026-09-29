import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { acceptanceOptions, acceptanceEvidence } from './test-acceptance.mjs'
import { runStages } from './run-stages.mjs'

test('acceptance accepts concurrency controls but refuses filters that would narrow required coverage', () => {
  assert.deepEqual(acceptanceOptions(['--workers', '5', '--desktop-workers', '2']), {
    list: false,
    workers: 5,
    desktopWorkers: 2,
  })
  for (const args of [
    ['--grep', 'boot'],
    ['--workers', '0'],
    ['--workers'],
    ['--retries', '1'],
    ['--project', 'protocol'],
  ]) {
    assert.throws(() => acceptanceOptions(args))
  }
})

test('aggregate rejects incomplete static and protocol evidence even when a command succeeds', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-acceptance-evidence-'))
  const file = resolve(directory, 'nested.json')
  try {
    assert.throws(() => acceptanceEvidence(file, 'protocol'))
    for (const report of [
      { status: 'passed', counts: { passed: 0, failed: 0, unexecuted: 0 } },
      { status: 'passed', counts: { passed: 1, failed: 0, unexecuted: 1 } },
      { status: 'passed', counts: { passed: 1, failed: 1, unexecuted: 0 } },
      { status: 'failed', counts: { passed: 1, failed: 0, unexecuted: 0 } },
    ]) {
      writeFileSync(file, JSON.stringify(report))
      assert.throws(() => acceptanceEvidence(file, 'protocol'))
    }
    writeFileSync(file, JSON.stringify({ status: 'passed', stages: [{ status: 'pending' }] }))
    assert.throws(() => acceptanceEvidence(file, 'static'))
    const code = await runStages(
      [
        ['incomplete evidence', [process.execPath, '-e', ''], { after: () => acceptanceEvidence(file, 'static') }],
        ['must not run', [process.execPath, '-e', 'process.exit(99)']],
      ],
      { root: process.cwd(), env: process.env, directory },
    )
    assert.notEqual(code, 0)
    writeFileSync(
      file,
      JSON.stringify({ status: 'passed', counts: { passed: 1, failed: 0, unexecuted: 0, skipped: 1 } }),
    )
    assert.equal(acceptanceEvidence(file, 'protocol').counts.skipped, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
