// In-process tests for the client journal directory lock (AGENTS.md test policy):
// one holder at a time across processes, takeover of a dead or silent holder, and
// no takeover race.
// Run after `pnpm build:sdk`: node --test packages/client/src/journal-lock.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { lockJournalDirectory } from '../dist/journals.js'

const journals = fileURLToPath(new URL('../dist/journals.js', import.meta.url))

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-journal-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** The process ID of a process that has exited. */
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((done) => child.on('exit', done))
  return child.pid
}

/** Leaves generation `n` held by `pid`, as a holder that stopped without releasing would. */
async function leaveLock(directory, n, pid, ageMs = 0) {
  const file = join(directory, `journals.lock.${n}`)
  await writeFile(file, JSON.stringify({ token: `left-${n}`, pid }))
  if (ageMs) {
    const then = new Date(Date.now() - ageMs)
    await utimes(file, then, then)
  }
}

test('the lock admits one holder at a time and the next once it is released', async (t) => {
  const directory = await scratch(t)
  const release = await lockJournalDirectory(directory)
  await assert.rejects(lockJournalDirectory(directory, { timeoutMs: 100 }), /in use by another process/)
  await release()
  await release()
  const again = await lockJournalDirectory(directory, { timeoutMs: 100 })
  await again()
})

test('a lock whose process has exited is taken over at once', async (t) => {
  const directory = await scratch(t)
  await leaveLock(directory, 3, await exitedPid())
  const release = await lockJournalDirectory(directory, { timeoutMs: 100 })
  // The taker holds the next generation and cleared the older one.
  assert.deepEqual((await readdir(directory)).sort(), ['journals.lock.4'])
  await release()
})

test('a lock whose process ID was reused is taken over once its heartbeat is old', async (t) => {
  const directory = await scratch(t)
  // A live process (this one's parent) holds the ID, but the lock has not been touched for a minute.
  await leaveLock(directory, 1, process.ppid, 60_000)
  const release = await lockJournalDirectory(directory, { timeoutMs: 100 })
  await release()
  // A live holder with a fresh heartbeat is not taken over.
  await leaveLock(directory, 7, process.ppid)
  await assert.rejects(lockJournalDirectory(directory, { timeoutMs: 100 }), /in use by another process/)
})

test('a holder that was taken over does not release its successor', async (t) => {
  const directory = await scratch(t)
  // The first holder stops refreshing its heartbeat; the second treats it as gone.
  const first = await lockJournalDirectory(directory, { heartbeatMs: 3_600_000 })
  const then = new Date(Date.now() - 60_000)
  await utimes(join(directory, 'journals.lock.1'), then, then)
  const second = await lockJournalDirectory(directory, { timeoutMs: 1_000 })
  await first()
  await assert.rejects(lockJournalDirectory(directory, { timeoutMs: 100 }), /in use by another process/)
  await second()
  const third = await lockJournalDirectory(directory, { timeoutMs: 100 })
  await third()
})

test('processes racing to take over a stale lock hold it one at a time', async (t) => {
  const directory = await scratch(t)
  await leaveLock(directory, 1, await exitedPid())
  const counter = join(directory, 'counter')
  await writeFile(counter, '0')
  // Each process reads the counter, waits, and writes it back one higher. Two
  // holders at once would lose an increment.
  const worker = `
    import { readFile, writeFile } from 'node:fs/promises'
    const { lockJournalDirectory } = await import(${JSON.stringify(journals)})
    const release = await lockJournalDirectory(${JSON.stringify(directory)}, { timeoutMs: 30000 })
    const value = Number(await readFile(${JSON.stringify(counter)}, 'utf8'))
    await new Promise((done) => setTimeout(done, 20))
    await writeFile(${JSON.stringify(counter)}, String(value + 1))
    await release()
  `
  const count = 8
  const codes = await Promise.all(
    Array.from({ length: count }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: 'inherit' })
      return new Promise((done) => child.on('exit', done))
    }),
  )
  assert.deepEqual(codes, Array(count).fill(0))
  assert.equal(await readFile(counter, 'utf8'), String(count))
})
