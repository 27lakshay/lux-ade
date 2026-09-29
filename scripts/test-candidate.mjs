import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRun, runStages, writeJson } from './run-stages.mjs'
import { acceptanceEvidence } from './test-acceptance.mjs'
import { verifyCandidate } from './package-candidate.mjs'

export function candidateOptions(args) {
  const options = { projects: [] }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--app' && !options.app) options.app = resolve(value)
    else if (flag === '--project' && ['package-protocol', 'package-desktop', 'package-desktop-current'].includes(value))
      options.projects.push(value)
    else throw new Error(`Unknown or repeated candidate option: ${flag} ${value}`)
  }
  if (!options.app) throw new Error('Supply an existing candidate: pnpm test:candidate --app "/absolute/Lux ADE.app"')
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = candidateOptions(process.argv.slice(2))
    const root = fileURLToPath(new URL('..', import.meta.url))
    const directory = createRun(root, 'candidate')
    writeJson(resolve(directory, 'selection.json'), { ...options, completeScope: options.projects.length === 0 })
    const reportDirectory = resolve(directory, 'package-candidate')
    process.exitCode = await runStages(
      [
        [
          'packaged protocol and desktop',
          ['pnpm', 'test:e2e:package', ...options.projects.flatMap((project) => ['--project', project])],
          {
            after: () => {
              const evidence = acceptanceEvidence(resolve(reportDirectory, 'summary.json'), 'package')
              const before = JSON.parse(readFileSync(resolve(reportDirectory, 'candidate.json'), 'utf8'))
              const candidate = verifyCandidate(options.app, before.artifact.sha256)
              writeJson(resolve(directory, 'candidate.json'), candidate)
              return evidence
            },
          },
        ],
      ],
      {
        root,
        directory,
        env: {
          ...process.env,
          ADE_E2E_PACKAGE_APP: options.app,
          ADE_TEST_REPORT_ROOT: directory,
          ADE_REPORT_RUN_ID: 'candidate',
        },
      },
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
