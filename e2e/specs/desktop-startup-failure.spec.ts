import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktop = resolve('apps/desktop')
const executable = createRequire(join(desktop, 'package.json'))('electron') as string

test('an isolated Electron startup failure exits without a blocking macOS dialog', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-startup-error-e2e-'))
  await writeFile(join(userData, 'pending-sends-v1.json'), '{invalid journal')
  const child = spawn(executable, [desktop], {
    env: { ...process.env, ADE_E2E_USER_DATA_DIR: userData, ADE_E2E_HIDE_WINDOW: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectExit(new Error('Electron startup stayed open, possibly behind a modal error dialog'))
      }, 8_000)
      child.once('error', (error) => { clearTimeout(timer); rejectExit(error) })
      child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }) })
    })
    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(stderr).toContain('Send recovery journal is invalid; preserve the file for recovery')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(userData, { recursive: true, force: true })
  }
})
