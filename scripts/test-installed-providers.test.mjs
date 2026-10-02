import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { installedSelection, installedPrerequisites } from './test-installed-providers.mjs'

test('installed selection covers all providers and rejects retries and unknown arguments', () => {
  assert.deepEqual(installedSelection([]).selected, ['codex', 'claude', 'opencode', 'omp'])
  assert.deepEqual(installedSelection(['--provider', 'claude', '--list']), { selected: ['claude'], list: true })
  for (const args of [['--provider'], ['--provider', 'unknown'], ['--retries', '1']])
    assert.throws(() => installedSelection(args))
})

test('prerequisites inspect executables without executing them, and reject directories', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-installed-prerequisites-'))
  try {
    const binary = resolve(directory, 'opencode')
    writeFileSync(binary, '#!/bin/sh\nexit 97\n', { mode: 0o700 })
    assert.deepEqual(
      installedPrerequisites(['omp'], { PATH: directory, ADE_BUN_BIN: binary, ADE_OMP_BIN: binary }, directory).missing,
      ['omp workspace dependencies (pnpm install)'],
    )
    assert.deepEqual(installedPrerequisites(['opencode'], { PATH: directory }, directory).missing, [
      'ade-daemon',
      'ade-runtime',
      'packaged OpenCode plugin (pnpm build:sdk)',
    ])
    mkdirSync(resolve(directory, 'not-a-binary'))
    assert.deepEqual(
      installedPrerequisites(
        ['opencode'],
        {
          PATH: directory,
          ADE_OPENCODE_LOOPBACK_BIN: resolve(directory, 'not-a-binary'),
        },
        directory,
      ).missing,
      ['opencode', 'ade-daemon', 'ade-runtime', 'packaged OpenCode plugin (pnpm build:sdk)'],
    )
    const result = spawnSync(process.execPath, ['scripts/test-installed-providers.mjs', '--provider', 'opencode'], {
      encoding: 'utf8',
      env: { ...process.env, ADE_OPENCODE_LOOPBACK_BIN: resolve(directory, 'absent') },
      timeout: 10000,
    })
    assert.equal(result.status, 1)
    const reportDirectory = /Test report: (.+)/.exec(result.stderr)?.[1]
    assert.ok(reportDirectory)
    const report = JSON.parse(readFileSync(resolve(reportDirectory, 'summary.json'), 'utf8'))
    assert.equal(report.failureCategory, 'prerequisite-unavailable')
    assert.deepEqual(report.unexecutedProviders, ['opencode'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
