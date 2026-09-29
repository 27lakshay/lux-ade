import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { liveLocalPrerequisites } from '../e2e/setup/live.ts'

test('live desktop prerequisites refuse missing binaries, builds and Claude config before launching', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ade-live-prerequisites-'))
  const env = { PATH: root, CLAUDE_CONFIG_DIR: resolve(root, 'claude-config') }
  try {
    for (const entry of [
      'codex',
      'claude',
      'node',
      'target/debug/ade-daemon',
      'target/debug/ade-runtime',
      'apps/desktop/out/main/index.js',
      'apps/desktop/out/preload/index.cjs',
      'apps/desktop/out/renderer/index.html',
      'providers/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ]) {
      assert.throws(() => liveLocalPrerequisites(root, env), /Live acceptance prerequisite missing/)
      const file = resolve(root, entry)
      mkdirSync(file, { recursive: true })
      assert.throws(() => liveLocalPrerequisites(root, env), /Live acceptance prerequisite missing/)
      rmSync(file, { recursive: true })
      mkdirSync(dirname(file), { recursive: true })
      // Lookup must never run a candidate executable.
      writeFileSync(file, '#!/bin/sh\nexit 97\n', { mode: 0o700 })
    }
    assert.throws(() => liveLocalPrerequisites(root, env), /existing CLAUDE_CONFIG_DIR/)
    mkdirSync(env.CLAUDE_CONFIG_DIR)
    assert.doesNotThrow(() => liveLocalPrerequisites(root, env))
    assert.throws(() => liveLocalPrerequisites(root, { ...env, ADE_CODEX_BIN: '/absent-codex' }), /Codex CLI/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the native live command classifies missing opt-in and retains F010 cases and known gaps', () => {
  const result = spawnSync(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.live.config.ts'],
    {
      env: { ...process.env, ADE_RUN_LIVE_PROVIDERS: '' },
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  assert.equal(result.status, 1)
  const directory = /Test report: (.+)/.exec(result.stdout + result.stderr)?.[1]
  assert.ok(directory)
  const report = JSON.parse(readFileSync(resolve(directory, 'summary.json'), 'utf8'))
  assert.equal(report.failureCategory, 'prerequisite-unavailable')
  assert.equal(report.counts.passed, 0)
  assert.equal(report.unexecutedTests.length, 4)
  assert.ok(report.unexecutedTests.every((entry) => entry.requirementIds.includes('F010')))
  assert.ok(report.acceptanceScope.knownGaps.length > 0)
})
