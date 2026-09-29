import { spawnSync } from 'node:child_process'
import { existsSync, globSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeTestGlobs, pythonChecks, externalTests, historicalTests } from './test-catalog.mjs'
import { providerCommands } from './test-providers.mjs'
import { validateOwnership } from './test-ownership.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env, PATH: `${resolve(root, '.ade/tools/bin')}:${process.env.PATH}`, FORCE_COLOR: '0' }
delete env.NO_COLOR
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`)
  return result.stdout
}
function playwrightFiles(name) {
  const report = JSON.parse(
    run(process.execPath, [
      'node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      `playwright.${name}.config.ts`,
      '--list',
      '--reporter=json',
    ]),
  )
  if (report.errors?.length) throw new Error(`Discovery failed for ${name}: ${JSON.stringify(report.errors)}`)
  const files = new Set()
  function visit(suite) {
    for (const spec of suite.specs ?? []) files.add(relative(root, resolve(report.config.rootDir, spec.file)))
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites) visit(suite)
  return [...files]
}

try {
  const tracked = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
  const candidates = [
    ...new Set(
      tracked.filter(
        (file) =>
          /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
          /(?:^|\/)test_[^/]+\.py$/.test(file) ||
          file === 'scripts/live_provider_check.py',
      ),
    ),
  ].filter((file) => existsSync(resolve(root, file)))
  const suites = [{ name: 'node', files: globSync(nodeTestGlobs, { cwd: root }) }]
  for (const entry of providerCommands([]).commands)
    suites.push({
      name: `provider-${entry.name}`,
      files: entry.args.slice(1).map((file) => relative(root, resolve(entry.cwd, file))),
    })
  const browser = JSON.parse(
    run('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json'], resolve(root, 'apps/desktop')),
  )
  suites.push({ name: 'browser', files: browser.map((entry) => relative(root, entry.file)) })
  for (const name of ['protocol', 'faults', 'devices', 'system', 'performance', 'desktop', 'package', 'live'])
    suites.push({ name, files: playwrightFiles(name) })
  suites.push({ name: 'python-static', files: pythonChecks.map((name) => `scripts/${name}`) })
  for (const [name, files] of Object.entries(externalTests)) suites.push({ name, files })
  const exclusions = Object.entries(historicalTests).map(([name, reason]) => ({ file: `scripts/${name}`, reason }))
  const overlaps = [
    { suites: ['protocol', 'devices'], reason: 'Device fixture acceptance is a named subset of correctness.' },
    { suites: ['faults', 'devices'], reason: 'The fault subset also exercises device-input refusal.' },
    { suites: ['protocol', 'faults'], reason: 'The fault command is a subset of correctness.' },
    {
      suites: ['protocol', 'system'],
      reason: 'The overload file contains separate tagged system and ordinary correctness cases.',
    },
    {
      suites: ['faults', 'system'],
      reason:
        'The overload file contains distinct fault and system cases; case partitions are verified by test-suites.',
    },
  ]
  const failures = validateOwnership({ files: candidates, suites, exclusions, overlaps })
  // Rust test bodies remain Cargo's responsibility. nextest enumerates the actual compiled workspace.
  const rust = JSON.parse(
    run(process.execPath, [
      'scripts/cargo.mjs',
      'nextest',
      'list',
      '--locked',
      '--workspace',
      '--features',
      'ade-runtime/native-terminal',
      '--message-format',
      'json',
    ]),
  )
  if (!(rust['test-count'] > 0) || !Object.keys(rust['rust-suites']).length)
    failures.push('Empty required Rust nextest suite')
  const summary = {
    suites: suites.map(({ name, files }) => ({ name, files: [...new Set(files)].sort() })),
    historical: exclusions,
    rustTests: rust['test-count'],
    ignoredRust: Object.values(rust['rust-suites']).flatMap((suite) =>
      Object.entries(suite.testcases)
        .filter(([, entry]) => entry.ignored)
        .map(([name]) => ({
          binary: suite['binary-id'],
          name,
          category:
            name === 'store::tests::creation_interruption_child'
              ? 'intentional-subprocess-helper'
              : 'unclassified-ignored-test',
        })),
    ),
    rustBinaries: Object.keys(rust['rust-suites']),
    failures,
  }
  if (process.env.ADE_DISCOVERY_REPORT)
    writeFileSync(process.env.ADE_DISCOVERY_REPORT, JSON.stringify(summary, null, 2))
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2))
  else {
    for (const suite of summary.suites) console.log(`${suite.name}: ${suite.files.length} files`)
    console.log(`Rust: ${summary.rustTests} discovered tests; ${exclusions.length} explicit historical exclusions`)
    for (const failure of failures) console.error(failure)
  }
  if (failures.length) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
