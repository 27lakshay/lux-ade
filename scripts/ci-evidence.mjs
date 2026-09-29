import { expectedStaticStages } from './static-stage-groups.mjs'

export const requiredJobs = ['javascript', 'native', 'protocol', 'desktop', 'dependencies']

/** Validate actual job outcomes and their downloaded reports before a required check passes. */
export function validateCiEvidence(revision, needs, reports) {
  if (!revision) throw new Error('Expected source revision is required')
  for (const job of requiredJobs) {
    if (needs[job]?.result !== 'success') throw new Error(`Required job ${job} did not succeed`)
    const report = reports[job]
    if (!report || report.status !== 'passed' || report.revision !== revision)
      throw new Error(`Required ${job} report is missing, failed or belongs to another revision`)
    if (['javascript', 'native', 'dependencies'].includes(job)) {
      const expected = job === 'dependencies' ? ['dependency checks'] : expectedStaticStages(job)
      if (!Array.isArray(report.stages)) throw new Error(`${job} stages are missing`)
      const names = report.stages.map((stage) => stage.name)
      if (
        names.length !== expected.length ||
        new Set(names).size !== names.length ||
        expected.some((name) => !names.includes(name))
      )
        throw new Error(`${job} stage coverage is incomplete or duplicated`)
      for (const stage of report.stages) {
        if (stage.status !== 'passed' || stage.exitCode !== 0) throw new Error(`${job}/${stage.name} did not pass`)
        if (
          stage.reports?.length &&
          (!Array.isArray(stage.native) ||
            stage.native.length !== stage.reports.length ||
            stage.native.some((native) => native.status !== 'passed'))
        )
          throw new Error(`${job}/${stage.name} native reports are missing or failed`)
      }
    } else {
      const counts = report.counts
      if (
        !counts ||
        !['passed', 'failed', 'skipped', 'unexecuted'].every(
          (key) => Number.isInteger(counts[key]) && counts[key] >= 0,
        ) ||
        counts.passed === 0 ||
        counts.failed ||
        counts.unexecuted
      )
        throw new Error(`${job} cases are missing, failed or unexecuted`)
      if (
        !Array.isArray(report.tests) ||
        report.tests.length !== counts.passed + counts.skipped ||
        new Set(report.tests.map((test) => test.id)).size !== report.tests.length
      )
        throw new Error(`${job} case inventory is missing or duplicated`)
      for (const state of ['passed', 'skipped']) {
        if (report.tests.filter((test) => test.status === state).length !== counts[state])
          throw new Error(`${job} case counts disagree with its inventory`)
      }
      if (report.errors?.length) throw new Error(`${job} contains report errors`)
    }
  }
  return { status: 'passed', revision, jobs: requiredJobs }
}
