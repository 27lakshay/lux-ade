import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRun, runStages } from './run-stages.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

export function acceptanceOptions(args) {
  const options = { list: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') options.list = true
    else if (['--workers', '--desktop-workers'].includes(args[i])) {
      const key = args[i] === '--workers' ? 'workers' : 'desktopWorkers'
      const count = Number(args[++i])
      if (!Number.isInteger(count) || count < 1) throw new Error('Worker counts must be positive integers')
      options[key] = count
    } else throw new Error(`Unknown acceptance argument: ${args[i]}. Use focused suite commands for filters.`)
  }
  return options
}

export function acceptanceEvidence(file, kind) {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  if (report.status !== 'passed') throw new Error(`Required ${kind} report is not passed: ${file}`)
  if (kind === 'static') {
    if (!report.stages?.length || report.stages.some((stage) => stage.status !== 'passed'))
      throw new Error(`Required static stages are missing or incomplete: ${file}`)
  } else if (
    !report.counts?.passed ||
    !['passed', 'failed', 'skipped', 'unexecuted'].every(
      (key) => Number.isInteger(report.counts[key]) && report.counts[key] >= 0,
    ) ||
    report.counts.failed ||
    report.counts.unexecuted
  ) {
    throw new Error(`Required ${kind} cases are missing, failed or unexecuted: ${file}`)
  }
  return { summary: file, counts: report.counts ?? null, stages: report.stages?.length ?? null }
}

/** @returns {Array<[string, string[], { env?: Record<string, string>, after?: () => unknown }?]>} */
export function acceptanceStages(directory, options) {
  const staticReport = resolve(directory, 'static', 'summary.json')
  const protocolReport = resolve(directory, 'protocol-acceptance', 'summary.json')
  const desktopReport = resolve(directory, 'desktop-acceptance', 'summary.json')
  return [
    [
      'static',
      ['pnpm', 'check:static'],
      {
        env: { ADE_STATIC_REPORT_DIR: resolve(directory, 'static') },
        after: () => acceptanceEvidence(staticReport, 'static'),
      },
    ],
    ['backend build', ['pnpm', 'build:backend']],
    [
      'protocol',
      ['pnpm', 'test:e2e:protocol:only', ...(options.workers ? ['--workers', String(options.workers)] : [])],
      {
        env: { ADE_TEST_REPORT_ROOT: directory, ADE_REPORT_RUN_ID: 'acceptance' },
        after: () => acceptanceEvidence(protocolReport, 'protocol'),
      },
    ],
    [
      'desktop',
      [
        'pnpm',
        'test:e2e:desktop:only',
        ...(options.desktopWorkers ? ['--workers', String(options.desktopWorkers)] : []),
      ],
      {
        env: { ADE_TEST_REPORT_ROOT: directory, ADE_REPORT_RUN_ID: 'acceptance' },
        after: () => acceptanceEvidence(desktopReport, 'desktop'),
      },
    ],
  ]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = acceptanceOptions(process.argv.slice(2))
    if (options.list) {
      for (const [name, command] of acceptanceStages('<run-directory>', options))
        console.log(`${name}: ${command.join(' ')}`)
    } else {
      const directory = process.env.ADE_ACCEPTANCE_REPORT_DIR ?? createRun(root, 'acceptance')
      process.exitCode = await runStages(acceptanceStages(directory, options), { root, env: process.env, directory })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
