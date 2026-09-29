import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCommand } from './test-process.mjs'

test('cancellation lets a runner descendant finish cleanup after its launcher exits', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-runner-cleanup-'))
  const ready = join(directory, 'ready.json')
  const cleaned = join(directory, 'cleaned')
  const signals = new EventEmitter()
  const worker = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const resource = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    process.once('SIGINT', () => setTimeout(() => {
      resource.once('exit', () => { writeFileSync(process.argv[2], 'cleaned'); process.exit(0); });
      resource.kill('SIGTERM');
    }, 100));
    writeFileSync(process.argv[1], JSON.stringify({ worker: process.pid, resource: resource.pid }));
    setInterval(() => {}, 1000);
  `
  const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}, ...process.argv.slice(1)], { stdio: 'inherit' });`
  const running = runCommand(
    { command: process.execPath, args: ['-e', launcher, ready, cleaned] },
    process.env,
    signals,
  )
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(existsSync(ready), 'worker and detached resource must start')
    signals.emit('SIGINT')
    assert.equal(await running, 130)
    assert.ok(existsSync(cleaned), 'runner descendant must finish cleanup before cancellation returns')
    const { resource } = JSON.parse(readFileSync(ready, 'utf8'))
    assert.throws(() => process.kill(resource, 0), { code: 'ESRCH' })
    assert.equal(signals.listenerCount('SIGINT'), 0)
    assert.equal(signals.listenerCount('SIGTERM'), 0)
  } finally {
    signals.emit('SIGTERM')
    await running
    if (existsSync(ready) && !existsSync(cleaned)) {
      for (const pid of Object.values(JSON.parse(readFileSync(ready, 'utf8')))) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          assert.equal(error.code, 'ESRCH')
        }
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test(
  'cancellation completes when macOS retains a group containing only a zombie',
  { skip: process.platform !== 'darwin', timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ade-zombie-group-'))
    const ready = join(directory, 'ready.json')
    const python = `
import os,time,json,sys
original = os.getpgrp()
if os.fork() == 0:
    os.setpgid(0, 0)
    os.close(1)
    os.close(2)
    zombie = os.fork()
    if zombie == 0:
        os.setpgid(0, original)
        os._exit(0)
    time.sleep(0.1)
    with open(sys.argv[1], 'w') as f: json.dump({'holder':os.getpid(),'zombie':zombie,'group':original},f)
    time.sleep(1)
    os.waitpid(zombie,0)
    os._exit(0)
time.sleep(10)
`
    const script = `
    import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events';
    import { existsSync } from 'node:fs';
    import { runCommand } from ${JSON.stringify(new URL('./test-process.mjs', import.meta.url).href)};
    const signals = new EventEmitter();
    const running = runCommand({ command: 'python3', args: ['-c', ${JSON.stringify(python)}, ${JSON.stringify(ready)}] }, process.env, signals);
    const deadline = Date.now() + 3000;
    while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (!existsSync(${JSON.stringify(ready)})) throw new Error('zombie fixture did not start');
    signals.emit('SIGTERM');
    const code = await running;
    if (code !== 143 || signals.listenerCount('SIGTERM') || signals.listenerCount('SIGINT')) throw new Error('cancellation did not finish cleanly');
  `
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 5000,
      })
      assert.equal(result.status, 0, result.stderr)
    } finally {
      // The detached holder reaps its child and exits after one second, even when the regression fails.
      const deadline = Date.now() + 3000
      if (existsSync(ready)) {
        const { holder } = JSON.parse(readFileSync(ready, 'utf8'))
        while (Date.now() < deadline) {
          try {
            process.kill(holder, 0)
          } catch (error) {
            assert.equal(error.code, 'ESRCH')
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert.throws(() => process.kill(holder, 0), { code: 'ESRCH' })
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
