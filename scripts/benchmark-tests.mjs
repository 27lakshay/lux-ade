import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './test-process.mjs'
import { createRun, runStages, writeJson } from './run-stages.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export function benchmarkOptions(args) {
  const options = { warmups: 0, filters: [] }
  const names = new Set(['suite', 'runs', 'workers', 'warmups', 'prepare', 'cache'])
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      options.filters = args.slice(i + 1)
      break
    }
    const name = args[i].replace(/^--/, '')
    if (!args[i].startsWith('--') || !names.has(name) || !args[i + 1])
      throw new Error(`Unknown or incomplete benchmark option: ${args[i]}`)
    const value = args[++i]
    options[name] = ['runs', 'workers', 'warmups'].includes(name) ? Number(value) : value
  }
  for (const key of ['runs', 'workers'])
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`Explicit positive --${key} is required`)
  if (!Number.isInteger(options.warmups) || options.warmups < 0)
    throw new Error('--warmups must be a nonnegative integer')
  if (!['acceptance', 'static', 'providers', 'browser', 'protocol', 'desktop', 'build-backend'].includes(options.suite))
    throw new Error('Choose --suite acceptance, static, providers, browser, protocol, desktop or build-backend')
  if (!['existing', 'build'].includes(options.prepare)) throw new Error('Choose --prepare existing or build')
  if (!['warm', 'cold-build'].includes(options.cache)) throw new Error('Choose --cache warm or cold-build')
  if (
    options.cache === 'cold-build' &&
    (options.suite !== 'build-backend' || options.prepare !== 'existing' || options.warmups !== 0)
  )
    throw new Error(
      'cold-build requires build-backend, existing preparation and zero warmups; each sample uses a fresh target without sccache',
    )
  if (options.filters.length && !['protocol', 'desktop', 'browser', 'providers'].includes(options.suite))
    throw new Error('This suite does not accept filters')
  const allowed =
    {
      providers: ['--provider', '--test-name-pattern'],
      browser: ['--testNamePattern', '-t'],
      protocol: ['--grep', '--grep-invert', '-g'],
      desktop: ['--grep', '--grep-invert', '-g'],
    }[options.suite] ?? []
  for (let i = 0; i < options.filters.length; i++) {
    const arg = options.filters[i]
    if (!arg.startsWith('-') && options.suite !== 'providers') continue
    const separator = arg.indexOf('=')
    const flag = separator < 0 ? arg : arg.slice(0, separator)
    if (!allowed.includes(flag)) throw new Error(`Unsupported benchmark filter: ${arg}`)
    const value = separator < 0 ? options.filters[++i] : arg.slice(separator + 1)
    if (!value || (separator < 0 && value.startsWith('-'))) throw new Error(`Missing filter value for ${flag}`)
  }
  return options
}

export function benchmarkCommand(options) {
  const commands = {
    acceptance: [
      'pnpm',
      'test:acceptance',
      '--workers',
      String(options.workers),
      '--desktop-workers',
      String(options.workers),
    ],
    static: ['pnpm', 'check:static'],
    providers: ['pnpm', 'test:providers'],
    browser: ['pnpm', '--filter', '@ade/desktop', 'test', '--maxWorkers', String(options.workers)],
    protocol: ['pnpm', 'test:e2e:protocol:only', '--workers', String(options.workers)],
    desktop: ['pnpm', 'test:e2e:desktop:only', '--workers', String(options.workers)],
    'build-backend': ['pnpm', 'build:backend'],
  }
  return [...commands[options.suite], ...options.filters]
}

// Hyperfine may leave an empty export when it aborts on a failed sample.
export function readBenchmarkNative(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function benchmarkSummary(native, samples, options) {
  const result = native?.results?.[0]
  const measured = samples.filter((sample) => !sample.iteration.startsWith('warmup-'))
  const errors = []
  if (samples.some((sample) => sample.status !== 'passed'))
    errors.push('One or more samples failed or remain incomplete')
  if (measured.length !== options.runs || result?.times?.length !== options.runs)
    errors.push('Missing measured samples')
  if (new Set(samples.map((sample) => sample.iteration)).size !== samples.length) errors.push('Duplicate sample IDs')
  if (samples.filter((sample) => sample.iteration.startsWith('warmup-')).length !== options.warmups)
    errors.push('Missing warmup samples')
  if (result?.exit_codes?.length !== options.runs || result.exit_codes.some((code) => code !== 0))
    errors.push('Hyperfine exit evidence is missing or failed')
  if (result?.times?.some((value) => !Number.isFinite(value) || value < 0)) errors.push('Invalid measured durations')
  return {
    status: errors.length ? 'failed' : 'passed',
    errors,
    options,
    samples,
    seconds: result ? { median: result.median, min: result.min, max: result.max, times: result.times } : null,
  }
}

async function sample(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const iteration = process.env.HYPERFINE_ITERATION
  if (!/^(?:warmup-)?\d+$/.test(iteration ?? '')) throw new Error('Missing Hyperfine iteration identity')
  const directory = resolve(config.directory, iteration)
  mkdirSync(directory) // A repeated identity must not overwrite an earlier sample.
  const env = {
    ...process.env,
    ADE_TEST_CACHE_CONDITION: config.options.cache,
    ADE_ACCEPTANCE_REPORT_DIR: resolve(directory, 'acceptance'),
    ADE_STATIC_REPORT_DIR: resolve(directory, 'static'),
    ADE_PROVIDER_REPORT_DIR: resolve(directory, 'providers'),
    ADE_BROWSER_REPORT_DIR: resolve(directory, 'browser'),
    ADE_TEST_REPORT_ROOT: directory,
    ADE_E2E_WORKERS: String(config.options.workers),
    ADE_TEST_WORKERS: String(config.options.workers),
    CARGO_BUILD_JOBS: String(config.options.workers),
    NEXTEST_TEST_THREADS: String(config.options.workers),
  }
  delete env.ADE_REPORT_RUN_ID
  if (config.options.cache === 'cold-build') {
    env.CARGO_TARGET_DIR = resolve(directory, 'target')
    env.RUSTC_WRAPPER = ''
    env.SCCACHE_DISABLE = '1'
  }
  const record = { iteration, options: config.options, directory, status: 'running' }
  writeJson(resolve(directory, 'sample.json'), record)
  const code = await runStages([[config.options.suite, benchmarkCommand(config.options)]], { root, env, directory })
  writeJson(resolve(directory, 'sample.json'), { ...record, status: code === 0 ? 'passed' : 'failed', exitCode: code })
  return code
}

async function benchmark(args) {
  const options = benchmarkOptions(args)
  const binary = resolve(root, '.ade/tools/bin/hyperfine')
  if (!existsSync(binary))
    throw new Error('Install the optional pinned tool: python3 scripts/install_tools.py hyperfine')
  const directory = createRun(root, 'benchmark')
  const file = resolve(directory, 'benchmark.json')
  writeJson(file, { directory, options, status: 'running' })
  console.log(`Benchmark: ${directory}\n${JSON.stringify(options)}`)
  if (options.prepare === 'build') {
    const builds = [
      ['backend', ['pnpm', 'build:backend']],
      ['SDK', ['pnpm', 'build:sdk']],
      ['CLI', ['pnpm', '--filter', '@ade/cli', 'build']],
    ]
    if (['acceptance', 'desktop', 'browser'].includes(options.suite))
      builds.push(['desktop', ['pnpm', '--filter', '@ade/desktop', 'build']])
    const code = await runStages(builds, { root, env: process.env, directory: resolve(directory, 'prepare') })
    if (code) {
      writeJson(file, { directory, options, status: 'failed', reason: 'preparation failed' })
      return code
    }
  }
  // Hyperfine parses quoted arguments with --shell=none; no shell evaluates the command.
  const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`
  const command = [process.execPath, fileURLToPath(import.meta.url), '--sample', file].map(quote).join(' ')
  const nativeFile = resolve(directory, 'hyperfine.json')
  const code = await runCommand(
    {
      command: binary,
      args: [
        '--shell=none',
        '--runs',
        String(options.runs),
        '--warmup',
        String(options.warmups),
        '--export-json',
        nativeFile,
        '--output=pipe',
        command,
      ],
      cwd: root,
      logFile: resolve(directory, 'hyperfine.log'),
    },
    process.env,
  )
  const samples = []
  for (const iteration of [
    ...Array.from({ length: options.warmups }, (_, i) => `warmup-${i}`),
    ...Array.from({ length: options.runs }, (_, i) => String(i)),
  ]) {
    const result = resolve(directory, iteration, 'sample.json')
    if (existsSync(result)) samples.push(JSON.parse(readFileSync(result, 'utf8')))
  }
  const native = readBenchmarkNative(nativeFile)
  const summary = benchmarkSummary(native, samples, options)
  if (code) summary.status = 'failed'
  writeJson(file, { directory, ...summary })
  console.log(`Benchmark ${summary.status}: ${file}`)
  return code || (summary.status === 'passed' ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode =
      process.argv[2] === '--sample' ? await sample(process.argv[3]) : await benchmark(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
