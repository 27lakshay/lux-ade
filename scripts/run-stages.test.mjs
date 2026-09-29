import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { runStages } from './run-stages.mjs'

const read = (directory) => JSON.parse(readFileSync(resolve(directory, 'summary.json'), 'utf8'))

test('zero exit without its required native report fails and leaves later stages pending', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-stages-'))
  try {
    const code = await runStages(
      [
        ['missing-report', [process.execPath, '-e', ''], { reports: [resolve(directory, 'absent.xml')] }],
        ['must-not-run', [process.execPath, '-e', 'process.exit(2)']],
      ],
      { root: process.cwd(), env: process.env, directory },
    )
    assert.notEqual(code, 0)
    assert.equal(read(directory).status, 'failed')
    assert.equal(read(directory).stages[1].status, 'pending')
    assert.equal(read(directory).stages[0].native[0].status, 'failed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('interruption preserves completed stages and unfinished work', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-stages-'))
  const marker = resolve(directory, 'ready')
  const signals = new EventEmitter()
  const running = runStages(
    [
      ['first', [process.execPath, '-e', '']],
      [
        'waiting',
        [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], ''); setInterval(()=>{},1000)",
          marker,
        ],
      ],
      ['later', [process.execPath, '-e', '']],
    ],
    { root: process.cwd(), env: process.env, directory, signals },
  )
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.ok(existsSync(marker))
    assert.equal(read(directory).status, 'running')
    signals.emit('SIGINT')
    assert.equal(await running, 130)
    const report = read(directory)
    assert.equal(report.status, 'interrupted')
    assert.deepEqual(
      report.stages.map((stage) => stage.status),
      ['passed', 'interrupted', 'pending'],
    )
  } finally {
    signals.emit('SIGTERM')
    await running
    rmSync(directory, { recursive: true, force: true })
  }
})
