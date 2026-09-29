import { readFileSync, statSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredJobs, validateCiEvidence } from './ci-evidence.mjs'
import { summarizePlaywright } from './report-summary.mjs'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Map the original CI path into its downloaded artifact, preserving subdirectories. */
export function downloadedReport(directory, job, original) {
  if (typeof original !== 'string') throw new Error(`${job} native report path is missing`)
  const marker = `/test-results/ci/${job}/`
  const offset = original.indexOf(marker)
  const local =
    offset >= 0
      ? original.slice(offset + marker.length)
      : original.startsWith(`test-results/ci/${job}/`)
        ? original.slice(`test-results/ci/${job}/`.length)
        : null
  if (!local) throw new Error(`${job} native report has an unexpected source path`)
  const file = resolve(directory, local)
  const inside = relative(resolve(directory), file)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('../'))
    throw new Error('Native report escaped its artifact')
  if (!statSync(file).isFile() || statSync(file).size === 0)
    throw new Error(`${job} native report is missing or empty: ${local}`)
  return file
}

export function checkDownloadedReports(directory, revision, needs) {
  const reports = {}
  for (const job of requiredJobs) {
    const artifact = resolve(directory, `reports-${job}`)
    const report = readJson(resolve(artifact, 'summary.json'))
    reports[job] = report
    if (['javascript', 'native', 'dependencies'].includes(job)) {
      for (const stage of report.stages ?? [])
        for (const native of stage.reports ?? []) downloadedReport(artifact, job, native)
    } else {
      const file = resolve(artifact, 'native.json')
      if (!statSync(file).isFile() || statSync(file).size === 0)
        throw new Error(`${job} native report is missing or empty`)
      const native = summarizePlaywright(readJson(file), { status: 'passed' })
      const inventory = (summary) => summary.tests.map(({ id, status, attempts }) => ({ id, status, attempts }))
      if (
        native.status !== 'passed' ||
        JSON.stringify(native.counts) !== JSON.stringify(report.counts) ||
        JSON.stringify(inventory(native)) !== JSON.stringify(inventory(report))
      )
        throw new Error(`${job} native execution evidence disagrees with its summary`)
    }
  }
  return validateCiEvidence(revision, needs, reports)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-ci-evidence.mjs <downloaded-reports>')
    console.log(
      JSON.stringify(
        checkDownloadedReports(process.argv[2], process.env.GITHUB_SHA, JSON.parse(process.env.ADE_CI_NEEDS ?? '{}')),
        null,
        2,
      ),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
