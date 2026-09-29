import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRun, runStages } from './run-stages.mjs'

export function browserArguments(args, workers) {
  if (args[0] === '--') args = args.slice(1)
  const explicitWorkers = args.some((arg) => arg === '--maxWorkers' || arg.startsWith('--maxWorkers='))
  return [...(workers && !explicitWorkers ? ['--maxWorkers', workers] : []), ...args]
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = process.env.ADE_BROWSER_REPORT_DIR ?? createRun(root, 'browser')
  const report = resolve(directory, 'vitest.json')
  const html = process.env.ADE_TEST_HTML === '1'
  const env = { ...process.env, ADE_BROWSER_HTML_DIR: html ? resolve(directory, 'html') : '' }
  process.exitCode = await runStages(
    [
      [
        'browser',
        [
          'pnpm',
          '--filter',
          '@ade/desktop',
          'exec',
          'vitest',
          'run',
          ...browserArguments(process.argv.slice(2), process.env.ADE_TEST_WORKERS),
          ...(html ? [] : ['--reporter=default', '--reporter=json']),
          `--outputFile=${report}`,
        ],
        { reports: [report] },
      ],
    ],
    { root, env, directory },
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
