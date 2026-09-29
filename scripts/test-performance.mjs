import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRun, runStages } from './run-stages.mjs'

export function performanceOptions(args) {
  const options = { diagnostics: false, list: false, filters: [] }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--diagnostics') options.diagnostics = true
    else if (args[i] === '--list') options.list = true
    else if (args[i] === '--grep') {
      const pattern = args[++i]
      if (!pattern || pattern.startsWith('-')) throw new Error('--grep requires a pattern')
      options.filters.push('--grep', `(?=.*@load)(?:${pattern})`)
    } else if (args[i] === '--workers' && args[++i] === '1') {
      // Accepted for existing invocations; performance always runs alone with one worker.
    } else
      throw new Error(
        'Use --grep <pattern>, --diagnostics or --list. Performance requires one worker and zero retries.',
      )
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = performanceOptions(process.argv.slice(2))
    const root = fileURLToPath(new URL('..', import.meta.url))
    const directory = createRun(root, 'performance-command')
    const command = [
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--config',
      'playwright.performance.config.ts',
      '--workers',
      '1',
      ...options.filters,
      ...(options.list ? ['--list', '--reporter=list'] : []),
    ]
    const steps = [
      ...(options.list
        ? []
        : [
            ['debug backend build', ['pnpm', 'build:backend']],
            ['SDK build', ['pnpm', 'build:sdk']],
            ['CLI build', ['pnpm', '--filter', '@ade/cli', 'build']],
          ]),
      ['performance', command],
    ]
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: resolve(root, 'target'),
      ADE_TEST_REPORT_ROOT: directory,
      ADE_REPORT_RUN_ID: 'workload',
      ADE_PERFORMANCE_BUILD_MODE: 'debug',
      ADE_PERFORMANCE_DIAGNOSTICS: options.diagnostics ? '1' : '0',
    }
    delete env.CARGO_BUILD_TARGET
    process.exitCode = await runStages(steps, {
      root,
      directory,
      env,
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
