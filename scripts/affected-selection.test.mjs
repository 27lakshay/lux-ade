import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { changedFiles, affectedSelection } from './affected-selection.mjs'
const suites = (files) => affectedSelection({ files }).suites.map((item) => item.suite)

test('shared backend, contracts, providers, fixtures and unknown inputs broaden acceptance', () => {
  for (const file of [
    'crates/ade-core/src/lib.rs',
    'packages/contracts/schema/contracts.json',
    'providers/claude/bridge.mjs',
    'e2e/protocol/fixtures/profile.ts',
    'pnpm-lock.yaml',
    'unknown/file.md',
    'docs/unknown-script.ts',
    'packages/client/src/send.ts',
    'apps/cli/src/index.ts',
    'crates/ade-runtime/src/lib.rs',
  ]) {
    assert.deepEqual(suites([file]), ['static', 'protocol', 'desktop'], file)
    assert.ok(affectedSelection({ files: [file] }).suites.every((item) => item.reasons.length))
  }
  assert.deepEqual(suites(['apps/desktop/src/renderer/button.tsx']), ['static', 'desktop'])
  assert.deepEqual(suites(['docs/testing.md']), ['static'])
})

test('Git selection includes committed, staged, unstaged, untracked, renamed and deleted paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ade-affected-'))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    for (const name of ['committed', 'staged', 'unstaged', 'renamed', 'deleted'])
      writeFileSync(join(root, name), 'original')
    git('add', '.')
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture base')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(root, 'committed'), 'committed change')
    git('add', 'committed')
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture change')
    writeFileSync(join(root, 'staged'), 'staged change')
    git('add', 'staged')
    writeFileSync(join(root, 'unstaged'), 'unstaged change')
    renameSync(join(root, 'renamed'), join(root, 'new-name'))
    git('add', 'renamed', 'new-name')
    rmSync(join(root, 'deleted'))
    mkdirSync(join(root, 'new'))
    writeFileSync(join(root, 'new', 'untracked'), 'untracked change')
    assert.deepEqual(changedFiles(root, base).files, [
      'committed',
      'deleted',
      'new-name',
      'new/untracked',
      'renamed',
      'staged',
      'unstaged',
    ])
    assert.deepEqual(
      affectedSelection(changedFiles(root, 'missing-ref')).suites.map((item) => item.suite),
      ['static', 'protocol', 'desktop'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
