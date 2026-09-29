import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { requiredJobs } from './ci-evidence.mjs'
import { expectedStaticStages } from './static-stage-groups.mjs'
import { summarizePlaywright } from './report-summary.mjs'
import { checkDownloadedReports, downloadedReport } from './check-ci-evidence.mjs'

test('downloaded evidence preserves subdirectories and rejects missing, empty or escaped reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'ade-ci-report-'))
  try {
    mkdirSync(join(root, 'providers'))
    const native = join(root, 'providers', 'provider-claude.xml')
    writeFileSync(native, '<testsuite/>')
    assert.equal(
      downloadedReport(root, 'javascript', '/runner/repo/test-results/ci/javascript/providers/provider-claude.xml'),
      native,
    )
    assert.throws(() => downloadedReport(root, 'javascript', '/runner/repo/test-results/ci/javascript/missing.xml'))
    writeFileSync(native, '')
    assert.throws(
      () =>
        downloadedReport(root, 'javascript', '/runner/repo/test-results/ci/javascript/providers/provider-claude.xml'),
      /empty/,
    )
    assert.throws(
      () => downloadedReport(root, 'javascript', '/runner/repo/test-results/ci/javascript/../../outside'),
      /escaped/,
    )
    assert.throws(() => downloadedReport(root, 'javascript', '/unrelated/native.xml'), /unexpected source/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the executable rejects missing reports even when invoked through a symbolic link', () => {
  const root = mkdtempSync(join(tmpdir(), 'ade-ci-cli-'))
  try {
    const executable = join(root, 'check-ci.mjs')
    symlinkSync(fileURLToPath(new URL('./check-ci-evidence.mjs', import.meta.url)), executable)
    const result = spawnSync(process.execPath, [executable, join(root, 'missing')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: 'abc', ADE_CI_NEEDS: '{}' },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('downloaded job artifacts require native execution evidence matching the summaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'ade-ci-artifacts-'))
  const needs = Object.fromEntries(requiredJobs.map((job) => [job, { result: 'success' }]))
  const native = {
    suites: [
      {
        specs: [
          {
            file: 'case.spec.ts',
            line: 1,
            column: 1,
            title: 'case',
            tests: [{ expectedStatus: 'passed', results: [{ status: 'passed', duration: 1 }] }],
          },
        ],
      },
    ],
  }
  try {
    for (const job of requiredJobs) {
      const directory = join(root, `reports-${job}`)
      mkdirSync(directory)
      const summary = ['protocol', 'desktop'].includes(job)
        ? summarizePlaywright(native, { status: 'passed', revision: 'abc' })
        : {
            status: 'passed',
            revision: 'abc',
            stages: (job === 'dependencies' ? ['dependency checks'] : expectedStaticStages(job)).map((name) => ({
              name,
              status: 'passed',
              exitCode: 0,
            })),
          }
      writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary))
      if (['protocol', 'desktop'].includes(job)) writeFileSync(join(directory, 'native.json'), JSON.stringify(native))
    }
    assert.equal(checkDownloadedReports(root, 'abc', needs).status, 'passed')
    const file = join(root, 'reports-protocol', 'native.json')
    writeFileSync(file, JSON.stringify({ suites: [] }))
    assert.throws(() => checkDownloadedReports(root, 'abc', needs), /native execution evidence/)
    const retried = structuredClone(native)
    retried.suites[0].specs[0].tests[0].results.unshift({ status: 'failed', duration: 1 })
    writeFileSync(file, JSON.stringify(retried))
    assert.throws(() => checkDownloadedReports(root, 'abc', needs), /native execution evidence/)
    rmSync(file)
    assert.throws(() => checkDownloadedReports(root, 'abc', needs), /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
