import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deterministicEnvironment, providerCommands, runProviderCommand } from './test-providers.mjs'

test('provider discovery includes omitted Claude cases and excludes external prerequisites', () => {
  const { commands } = providerCommands([])
  assert.deepEqual(
    commands.map((entry) => entry.name),
    ['claude', 'opencode', 'omp'],
  )
  assert.ok(commands[0].args.includes('./tasks.test.mjs'))
  assert.ok(commands[0].args.includes('./subagents.test.mjs'))
  assert.equal(commands[2].command, 'bun')
  for (const entry of commands) {
    assert.ok(!entry.args.some((arg) => arg === './live.test.mjs' || arg === './loopback.test.mjs'))
  }
})

test('filters remain separate arguments and invalid requests fail before any runner starts', () => {
  const { commands, list } = providerCommands(['--provider', 'omp', '--test-name-pattern', 'a b|c', '--list'])
  assert.equal(list, true)
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0].args.slice(0, 3), ['test', '--test-name-pattern', 'a b|c'])
  assert.throws(() => providerCommands(['--provider', 'missing']))
  assert.throws(() => providerCommands(['--test-name-pattern']))
  assert.throws(() => providerCommands(['--retry', '1']))
})

test('deterministic execution removes inherited live opt-ins without mutating the caller', () => {
  const source = {
    PATH: '/bin',
    ADE_OMP_LIVE: '1',
    ADE_OMP_LOOPBACK: '1',
    ADE_OPENCODE_LIVE_BIN: 'live',
    ADE_OPENCODE_LOOPBACK_BIN: 'installed',
  }
  assert.deepEqual(deterministicEnvironment(source), { PATH: '/bin' })
  assert.equal(source.ADE_OMP_LIVE, '1')
})

test('runner failures and missing executables are nonzero', async () => {
  assert.equal(
    await runProviderCommand({ command: process.execPath, args: ['-e', 'process.exit(23)'] }, process.env),
    23,
  )
  assert.notEqual(await runProviderCommand({ command: '/nonexistent/ade-test-runner', args: [] }, process.env), 0)
})

test('cancellation reaches runner and descendant and removes signal listeners', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-provider-runner-'))
  const ready = join(directory, 'ready')
  const signals = new EventEmitter()
  const script = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    writeFileSync(process.argv[1], String(child.pid)); setInterval(()=>{},1000);`
  const running = runProviderCommand(
    { command: process.execPath, args: ['--input-type=module', '-e', script, ready] },
    process.env,
    signals,
  )
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.ok(existsSync(ready), 'runner must become ready')
    const descendant = Number(readFileSync(ready, 'utf8'))
    signals.emit('SIGTERM')
    assert.equal(await running, 143)
    const exitDeadline = Date.now() + 3000
    let alive = true
    while (alive && Date.now() < exitDeadline) {
      try {
        process.kill(descendant, 0)
      } catch (error) {
        if (error.code === 'ESRCH') alive = false
        else throw error
      }
      if (alive) await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(alive, false, 'descendant must stop')
    assert.equal(signals.listenerCount('SIGTERM'), 0)
    assert.equal(signals.listenerCount('SIGINT'), 0)
  } finally {
    signals.emit('SIGTERM')
    await running
    rmSync(directory, { recursive: true, force: true })
  }
})
