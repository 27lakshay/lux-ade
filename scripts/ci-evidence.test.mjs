import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCiEvidence, requiredJobs } from './ci-evidence.mjs'
import { expectedStaticStages } from './static-stage-groups.mjs'
function fixture() {
  const needs = Object.fromEntries(requiredJobs.map((job) => [job, { result: 'success' }]))
  const reports = Object.fromEntries(
    requiredJobs.map((job) => [
      job,
      {
        status: 'passed',
        revision: 'abc',
        ...(['protocol', 'desktop'].includes(job)
          ? {
              counts: { passed: 1, failed: 0, skipped: 0, unexecuted: 0 },
              tests: [{ id: 'case', status: 'passed' }],
            }
          : {
              stages: (job === 'dependencies' ? ['dependency checks'] : expectedStaticStages(job)).map((name) => ({
                name,
                status: 'passed',
                exitCode: 0,
              })),
            }),
      },
    ]),
  )
  return { needs, reports }
}
test('complete compatible job evidence passes', () => {
  const { needs, reports } = fixture()
  assert.equal(validateCiEvidence('abc', needs, reports).status, 'passed')
})
test('missing, skipped, cancelled and failed required jobs cannot yield aggregate success', () => {
  for (const job of requiredJobs)
    for (const result of [undefined, 'skipped', 'cancelled', 'failure']) {
      const { needs, reports } = fixture()
      needs[job] = { result }
      assert.throws(() => validateCiEvidence('abc', needs, reports), /did not succeed/)
    }
})
test('missing reports, mismatched revisions and incomplete case or stage evidence fail', () => {
  const mutations = [
    (reports) => delete reports.desktop,
    (reports) => (reports.protocol.revision = 'other'),
    (reports) => reports.javascript.stages.pop(),
    (reports) => reports.native.stages.push(reports.native.stages[0]),
    (reports) => (reports.protocol.tests = []),
    (reports) => (reports.desktop.counts.failed = 1),
    (reports) => (reports.desktop.counts.unexecuted = 1),
    (reports) => (reports.javascript.stages[0].reports = ['missing.xml']),
  ]
  for (const mutate of mutations) {
    const { needs, reports } = fixture()
    mutate(reports)
    assert.throws(() => validateCiEvidence('abc', needs, reports))
  }
})
