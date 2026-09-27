// Recovery helpers for crash and restart specs.
//
// The daemon records the process identity of each provider and terminal
// process every 2 seconds (architecture section 4, "Runtime restart
// reconciliation"). No query exposes that record, and an attempt that crashes
// before it is recorded is deliberately classified `unknown`. A spec that
// needs the recorded path waits for the record by reading the profile's
// database read-only with the system sqlite3, so it never sleeps.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import type { ScratchProfile } from './profile'

const execFileAsync = promisify(execFile)

export type AttemptRecord = { key: string; attempt: string | null; pid: number; leader: boolean }

/**
 * The attempt records the daemon holds for a runtime incarnation: the running
 * one by default. Pass the incarnation while no daemon runs.
 */
export async function attemptRecords(profile: ScratchProfile,
  runtimeInstance = profile.hello.runtime_instance): Promise<AttemptRecord[]> {
  const database = join(profile.dataDirectory, 'sessions.sqlite')
  const instance = runtimeInstance.replaceAll("'", "''")
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', database,
    `SELECT key, attempt, pid, leader FROM runtime_attempt_records WHERE instance = '${instance}'`])
    .catch(() => ({ stdout: '' }))
  const rows = stdout.trim() ? JSON.parse(stdout) as Array<Omit<AttemptRecord, 'leader'> & { leader: number }> : []
  return rows.map((row) => ({ ...row, leader: row.leader === 1 }))
}

/** Wait until the daemon has recorded the process identity for `key`, such as `agent:<conversation>`. */
export async function waitForAttemptRecord(profile: ScratchProfile, key: string, timeout = 10_000): Promise<AttemptRecord> {
  let found: AttemptRecord | undefined
  await expect.poll(async () => {
    found = (await attemptRecords(profile)).find((record) => record.key === key)
    return found !== undefined
  }, { timeout, message: `the daemon to record ${key}` }).toBe(true)
  return found!
}

/** Provider and descendant fixtures for fault specs. Pass a provider as `ADE_CODEX_BIN` in `ade.profile({ env })`. */
export const recoveryFixtures = {
  /** `escapee.py <directory> <linger>`: ignores TERM and HUP, leaves its group, writes `<directory>/escaped.pid`. */
  escapee: join(__dirname, 'escapee.py'),
  /** The Codex mock with TERM and HUP ignored and an escaped descendant; writes `<mock dir>/escaped.pid`. */
  stubbornCodex: join(__dirname, 'codex_stubborn.sh'),
  /** The Codex mock behind a proxy whose `flood` prompt streams about 40 MiB once `flood-release` exists. */
  floodCodex: join(__dirname, 'codex_flood.py'),
}

/** Wait until `path` holds a PID and return it. */
export async function waitForPidFile(path: string, timeout = 15_000): Promise<number> {
  let pid = 0
  await expect.poll(async () => {
    pid = Number((await readFile(path, 'utf8').catch(() => '')).trim())
    return pid
  }, { timeout, message: `${path} to name a process` }).toBeGreaterThan(0)
  return pid
}
