import { createRun, runStages } from './run-stages.mjs'
export { runCommand as runProviderCommand } from './test-process.mjs'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const providers = ['claude', 'opencode', 'omp']
// These files require an installed provider or credentials, even when backed by loopback HTTP.
const externalFiles = new Set(['live.test.mjs', 'loopback.test.mjs'])

export function deterministicEnvironment(source) {
  const env = { ...source }
  for (const name of ['ADE_OPENCODE_LIVE_BIN', 'ADE_OPENCODE_LOOPBACK_BIN', 'ADE_OMP_LIVE', 'ADE_OMP_LOOPBACK']) {
    delete env[name]
  }
  return env
}

export function providerCommands(args, directory = root) {
  let selected = providers
  const filters = []
  let list = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--list') list = true
    else if (arg === '--provider') {
      const name = args[++i]
      if (!providers.includes(name)) throw new Error('Expected --provider claude, opencode or omp')
      selected = [name]
    } else if (arg === '--test-name-pattern') {
      const pattern = args[++i]
      if (!pattern) throw new Error('Expected a value for --test-name-pattern')
      filters.push('--test-name-pattern', pattern)
    } else throw new Error(`Unknown provider test argument: ${arg}`)
  }
  return {
    list,
    commands: selected.map((name) => {
      const cwd = resolve(directory, 'providers', name)
      const files = readdirSync(cwd)
        .filter((file) => file.endsWith('.test.mjs') && !externalFiles.has(file))
        .sort()
        .map((file) => `./${file}`)
      if (files.length === 0) throw new Error(`No deterministic tests for ${name}`)
      return {
        name,
        cwd,
        command: name === 'omp' ? 'bun' : process.execPath,
        args: [name === 'omp' ? 'test' : '--test', ...filters, ...files],
      }
    }),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { list, commands } = providerCommands(process.argv.slice(2))
    if (list) {
      for (const entry of commands) console.log(`providers/${entry.name}: ${entry.args.join(' ')}`)
    } else {
      const directory = process.env.ADE_PROVIDER_REPORT_DIR ?? createRun(root, 'providers')
      const steps = commands.map((entry) => {
        const report = resolve(directory, `provider-${entry.name}.xml`)
        const args =
          entry.name === 'omp'
            ? [...entry.args, '--reporter=junit', '--reporter-outfile', report]
            : [
                entry.args[0],
                ...(process.env.ADE_TEST_WORKERS ? [`--test-concurrency=${process.env.ADE_TEST_WORKERS}`] : []),
                '--test-reporter=spec',
                '--test-reporter=junit',
                '--test-reporter-destination=stdout',
                `--test-reporter-destination=${report}`,
                ...entry.args.slice(1),
              ]
        // Native file arguments are relative to the provider directory.
        return [entry.name, [entry.command, ...args], { cwd: entry.cwd, reports: [report] }]
      })
      process.exitCode = await runStages(steps, { root, env: deterministicEnvironment(process.env), directory })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
