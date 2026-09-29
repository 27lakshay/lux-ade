import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizePlaywright, mergeSummaries } from './report-summary.mjs'
const native = (result = { status: 'passed', duration: 3 }) => ({
  errors: [],
  suites: [
    {
      specs: [
        {
          file: 'a.spec.ts',
          line: 1,
          column: 1,
          title: 'a',
          tests: [{ projectId: 'p', expectedStatus: 'passed', results: result ? [result] : [] }],
        },
      ],
    },
  ],
})

test('successful native execution retains wall time separately from test duration', () => {
  const report = summarizePlaywright(native(), { status: 'passed', wallMs: 10 })
  assert.equal(report.status, 'passed')
  assert.equal(report.wallMs, 10)
  assert.equal(report.summedTestMs, 3)
})
test('missing, unexecuted, failed and interrupted evidence cannot become success', () => {
  assert.equal(summarizePlaywright(null, { status: 'passed' }).status, 'failed')
  assert.equal(summarizePlaywright(native(null), { status: 'passed' }).status, 'failed')
  assert.equal(summarizePlaywright(native({ status: 'failed', duration: 2 }), { status: 'passed' }).status, 'failed')
  assert.equal(summarizePlaywright(native(), { status: 'interrupted' }).status, 'interrupted')
  const setup = native()
  setup.errors.push({ message: 'Package prerequisite missing' })
  assert.equal(summarizePlaywright(setup, { status: 'passed' }).status, 'failed')
})
test('duplicate records and retries remain visible and fail the correctness summary', () => {
  const report = native()
  report.suites.push(report.suites[0])
  assert.match(summarizePlaywright(report, { status: 'passed' }).errors[0], /Duplicate/)
  const retried = native()
  retried.suites[0].specs[0].tests[0].results.unshift({ status: 'failed', duration: 5 })
  assert.equal(summarizePlaywright(retried, { status: 'passed' }).status, 'failed')
})
test('known-gap skips retain their reason and are distinct from unexecuted cases', () => {
  const report = native({ status: 'skipped', duration: 0 })
  report.suites[0].specs[0].tests[0].annotations = [{ type: 'fixme', description: 'Surface not implemented' }]
  const summary = summarizePlaywright(report, { status: 'passed' })
  assert.equal(summary.tests[0].skipCategory, 'known-gap')
  assert.equal(summary.tests[0].skipReason, 'Surface not implemented')
  assert.equal(summary.counts.unexecuted, 0)
})
test('shard merge rejects missing, repeated and failed shards and duplicate tests', () => {
  const a = { shard: 1, status: 'passed', tests: [{ id: 'a' }] }
  const b = { shard: 2, status: 'passed', tests: [{ id: 'b' }] }
  assert.equal(mergeSummaries([a, b], [1, 2]).status, 'passed')
  for (const reports of [[a], [a, a], [a, { ...b, status: 'failed' }], [a, { ...b, tests: a.tests }], [null, b]])
    assert.equal(mergeSummaries(reports, [1, 2]).status, 'failed')
})

test('reloading config in an inherited worker keeps artifacts in the parent run directory', async () => {
  const { reporting } = await import('../e2e/reporting.ts')
  const { execFileSync } = await import('node:child_process')
  const original = process.env.ADE_REPORT_RUN_ID
  try {
    delete process.env.ADE_REPORT_RUN_ID
    const parent = reporting('protocol')
    assert.equal(reporting('protocol').outputDir, parent.outputDir)
    const worker = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {reporting} from './e2e/reporting.ts'; console.log(reporting('protocol').outputDir)",
      ],
      { encoding: 'utf8', env: process.env },
    ).trim()
    assert.equal(worker, parent.outputDir)
    assert.notEqual(reporting('desktop').outputDir, parent.outputDir)
  } finally {
    if (original === undefined) delete process.env.ADE_REPORT_RUN_ID
    else process.env.ADE_REPORT_RUN_ID = original
  }
})

test('prerequisite failures remain failed and requirement IDs survive nested suite titles', () => {
  const report = native(null)
  report.suites[0].title = 'F098 device control'
  report.suites[0].specs[0].title = 'F099 F098 R004 case'
  const summary = summarizePlaywright(report, { status: 'failed', prerequisites: { status: 'unavailable' } })
  assert.equal(summary.failureCategory, 'prerequisite-unavailable')
  assert.equal(summary.status, 'failed')
  assert.deepEqual(summary.tests[0].requirementIds, ['F098', 'F099', 'R004'])
  assert.equal(summary.tests[0].status, 'unexecuted')
  assert.equal(summarizePlaywright(report, { status: 'failed' }).failureCategory, null)
  assert.equal(
    summarizePlaywright(native(), { status: 'passed', prerequisites: { status: 'unavailable' } }).status,
    'failed',
  )
})

test('a suite containing only skipped cases cannot claim verified acceptance', () => {
  const report = native({ status: 'skipped', duration: 0 })
  const summary = summarizePlaywright(report, { status: 'passed' })
  assert.equal(summary.status, 'failed')
  assert.equal(summary.counts.passed, 0)
  assert.equal(summary.counts.skipped, 1)
  assert.ok(summary.errors.includes('No test cases passed'))
  const mixed = native()
  mixed.suites[0].specs.push({ ...report.suites[0].specs[0], title: 'known gap', line: 2 })
  assert.equal(summarizePlaywright(mixed, { status: 'passed' }).status, 'passed')
})
