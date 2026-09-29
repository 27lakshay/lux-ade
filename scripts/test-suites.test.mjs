import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
function run(suite, args, overrides = {}) {
  const env = { ...process.env, FORCE_COLOR: '0', ...overrides }
  delete env.NO_COLOR
  return spawnSync(
    process.execPath,
    [
      resolve(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      `playwright.${suite}.config.ts`,
      ...args,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  )
}
function discover(suite) {
  const result = run(suite, ['--list', '--reporter=json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const report = JSON.parse(result.stdout)
  const cases = []
  function walk(group) {
    for (const spec of group.specs ?? []) cases.push(`${spec.file}: ${spec.title}`)
    for (const child of group.suites ?? []) walk(child)
  }
  for (const group of report.suites) walk(group)
  assert.ok(cases.length > 0, `${suite} must not be empty`)
  return { cases, report }
}

test(
  'native discovery partitions protocol, load, package and system, preserving the fault subset',
  { timeout: 30000 },
  () => {
    const protocol = discover('protocol')
    const faults = discover('faults')
    const devices = discover('devices')
    assert.ok(devices.cases.every((name) => protocol.cases.includes(name)))
    assert.deepEqual(
      devices.cases,
      protocol.cases.filter((name) => /^(devices\/|devplug\/device-input\.spec\.ts:)/.test(name)),
    )
    assert.equal(devices.report.config.metadata.acceptanceScope.physicalDeviceAcceptance, 'unexecuted')
    const system = discover('system')
    const performance = discover('performance')
    const packaged = discover('package')
    assert.ok(protocol.cases.every((name) => !/@load|@system|packaged\//.test(name)))
    assert.ok(faults.cases.every((name) => protocol.cases.includes(name)))
    assert.ok(system.cases.every((name) => name.includes('@system')))
    assert.ok(performance.cases.every((name) => name.includes('@load')))
    assert.ok(performance.cases.some((name) => name.includes('startup: five fresh profiles')))
    assert.ok(performance.cases.some((name) => name.includes('terminal streaming: three slow')))
    assert.ok(performance.cases.every((name) => !protocol.cases.includes(name)))
    assert.ok(packaged.report.config.projects.some((project) => project.name === 'package-protocol'))
    assert.ok(packaged.report.config.projects.some((project) => project.name === 'package-desktop'))
    for (const { report } of [protocol, faults, system, performance, packaged]) {
      assert.ok(report.config.projects.every((project) => project.retries === 0))
    }
    assert.equal(system.report.config.workers, 1)
    assert.equal(performance.report.config.workers, 1)
  },
)

test('explicit optional suites fail on missing prerequisites instead of passing as skipped', { timeout: 30000 }, () => {
  for (const [suite, env, expected] of [
    ['package', { ADE_E2E_PACKAGE_APP: '/nonexistent/ade-candidate.app' }, /Package prerequisite|requires macOS/],
    ['system', { ADE_E2E_SYSTEM: '' }, /requires explicit ADE_E2E_SYSTEM=1/],
    ['live', { ADE_RUN_LIVE_PROVIDERS: '' }, /requires ADE_RUN_LIVE_PROVIDERS=1/],
  ]) {
    assert.ok(typeof suite === 'string')
    const directory = mkdtempSync(resolve(tmpdir(), 'ade-prerequisite-report-'))
    const runId = randomUUID()
    try {
      const result = run(suite, [], { ...env, ADE_TEST_REPORT_ROOT: directory, ADE_REPORT_RUN_ID: runId })
      assert.notEqual(result.status, 0)
      assert.match(result.stdout + result.stderr, expected)
      assert.doesNotMatch(result.stdout + result.stderr, /\d+ passed/)
      const summary = JSON.parse(readFileSync(resolve(directory, `${suite}-${runId}`, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'failed')
      assert.equal(summary.failureCategory, 'prerequisite-unavailable')
      assert.equal(summary.counts.passed, 0)
      assert.equal(summary.prerequisites.status, 'unavailable')
      assert.equal(summary.prerequisites.inventoryError, null)
      assert.ok(summary.unexecutedTests.length > 0)
      assert.ok(
        summary.unexecutedTests.every(
          (entry) =>
            entry.status === 'unexecuted' && entry.attempts === 0 && entry.evidence === 'native-discovery-only',
        ),
      )
      const discovered = discover(suite)
      assert.equal(summary.unexecutedTests.length, discovered.cases.length)
      if (suite === 'system') assert.ok(summary.unexecutedTests.some((entry) => entry.requirementIds.length > 0))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('performance refuses extra workers and correctness retries before launching workloads', { timeout: 30000 }, () => {
  for (const args of [
    ['--workers', '2'],
    ['--retries', '1'],
  ]) {
    const result = run('performance', [...args, '--reporter=line'])
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /exactly one worker and zero retries/)
    assert.doesNotMatch(result.stdout + result.stderr, /\d+ passed/)
  }
})
