import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { affectedOptions, affectedStages } from './test-affected.mjs'
import { affectedSelection } from './affected-selection.mjs'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ade-affected-cli-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'bin'))
  for (const file of [
    'test-affected.mjs',
    'affected-selection.mjs',
    'test-acceptance.mjs',
    'run-stages.mjs',
    'test-process.mjs',
  ])
    copyFileSync(join(import.meta.dirname, file), join(root, 'scripts', file))
  writeFileSync(
    join(root, 'bin', 'pnpm'),
    `#!/usr/bin/env node
if (process.argv[2] === '--version') console.log('fixture');
else if (process.env.ADE_AFFECTED_FIXTURE === 'fail') process.exit(7);
else { require('node:fs').writeFileSync(process.env.ADE_AFFECTED_MARKER, String(process.pid)); setInterval(() => {}, 1000); }
`,
    { mode: 0o755 },
  )
  return {
    root,
    marker: join(root, 'ready'),
    command: join(root, 'scripts', 'test-affected.mjs'),
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ADE_AFFECTED_MARKER: join(root, 'ready') },
    report() {
      const runs = join(root, 'test-results', 'runs')
      const directories = readdirSync(runs)
      assert.equal(directories.length, 1)
      return JSON.parse(readFileSync(join(runs, directories[0], 'summary.json'), 'utf8'))
    },
  }
}

test('focused execution uses the same selection and shared build prerequisites', () => {
  assert.deepEqual(affectedOptions(['--base', 'main', '--list', '--workers', '3']), {
    list: true,
    base: 'main',
    workers: 3,
  })
  for (const args of [['--base'], ['--workers', '0'], ['--retries', '1']]) assert.throws(() => affectedOptions(args))
  for (const [files, names] of [
    [['docs/testing.md'], ['static']],
    [['apps/desktop/src/main/index.ts'], ['static', 'backend build', 'desktop']],
    [['packages/contracts/schema/contracts.json'], ['static', 'backend build', 'protocol', 'desktop']],
  ]) {
    const stages = affectedStages('<report>', affectedSelection({ files }), 3)
    assert.deepEqual(
      stages.map(([name]) => name),
      names,
    )
    for (const [name, command] of stages)
      if (['protocol', 'desktop'].includes(name)) assert.deepEqual(command.slice(-2), ['--workers', '3'])
  }
})

test('the affected CLI forwards a runner failure and leaves later suites pending', () => {
  const fixture = sandbox()
  try {
    const result = spawnSync(process.execPath, [fixture.command], {
      cwd: fixture.root,
      env: { ...fixture.env, ADE_AFFECTED_FIXTURE: 'fail' },
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(result.status, 7, result.stderr)
    const report = fixture.report()
    assert.equal(report.status, 'failed')
    assert.deepEqual(
      report.stages.map((stage) => stage.status),
      ['failed', 'pending', 'pending', 'pending'],
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test(
  'cancelling the affected CLI interrupts its runner and stops the remaining suites',
  { timeout: 15000 },
  async () => {
    const fixture = sandbox()
    const child = spawn(process.execPath, [fixture.command], { cwd: fixture.root, env: fixture.env, stdio: 'ignore' })
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    try {
      const deadline = Date.now() + 8000
      while (
        !existsSync(fixture.marker) &&
        child.exitCode === null &&
        child.signalCode === null &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(existsSync(fixture.marker), 'selected runner started')
      const runnerPid = Number(readFileSync(fixture.marker, 'utf8'))
      child.kill('SIGINT')
      assert.deepEqual(await exited, { code: 130, signal: null })
      assert.throws(() => process.kill(runnerPid, 0), { code: 'ESRCH' })
      const report = fixture.report()
      assert.equal(report.status, 'interrupted')
      assert.deepEqual(
        report.stages.map((stage) => stage.status),
        ['interrupted', 'pending', 'pending', 'pending'],
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
      rmSync(fixture.root, { recursive: true, force: true })
    }
  },
)
