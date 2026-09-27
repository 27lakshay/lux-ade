// The local `ade-control` binary: backup, inspect and restore of a data
// directory, and profile registry commands. It is a public CLI with no socket,
// so it runs beside a profile rather than through it. Every run gets the
// scratch environment rooted at the harness, never the user's HOME.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { repositoryRoot, scratchEnvironment } from './environment'
import type { AdeHarness } from './index'
import type { CliResult } from './profile'

export const controlBinary = join(repositoryRoot, 'target/debug/ade-control')

function environment(ade: AdeHarness, extra: Record<string, string>): Record<string, string> {
  return scratchEnvironment(join(ade.root, 'control-home'), extra)
}

/** Run `ade-control` to completion. Never throws for a non-zero exit. */
export async function control(
  ade: AdeHarness,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliResult> {
  await mkdir(join(ade.root, 'control-home'), { recursive: true })
  return new Promise<CliResult>((resolveResult) => {
    execFile(
      controlBinary,
      args,
      {
        cwd: ade.root,
        env: environment(ade, options.env ?? {}),
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string }) | null
        const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0
        resolveResult({ code, stdout, stderr, json: parseJson(code === 0 ? stdout : stderr) })
      },
    )
  })
}

/**
 * Start `ade-control` without waiting for it, for a test that must act while
 * it runs or kill it part-way. The process is owned by the harness ledger.
 */
export async function spawnControl(
  ade: AdeHarness,
  args: string[],
  options: { env?: Record<string, string> } = {},
): Promise<{ child: ChildProcess; done: Promise<CliResult> }> {
  await mkdir(join(ade.root, 'control-home'), { recursive: true })
  const child = spawn(controlBinary, args, {
    cwd: ade.root,
    env: environment(ade, options.env ?? {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const done = new Promise<CliResult>((resolveResult) => {
    child.once('close', (code, signal) => {
      const exit = code ?? (signal ? -1 : 0)
      resolveResult({ code: exit, stdout, stderr, json: parseJson(exit === 0 ? stdout : stderr) })
    })
  })
  if (typeof child.pid === 'number') await ade.ledger.own(child.pid, 'ade-control')
  return { child, done }
}

/**
 * The data directory `ade.profile()` will use for the next profile it starts.
 * A restore writes there first, so the next profile's daemon opens the
 * restored data. Profiles are numbered in start order under the harness root.
 */
export async function nextProfileDataDirectory(ade: AdeHarness): Promise<string> {
  const started = (await readdir(ade.root).catch(() => [] as string[])).filter((name) => /^p\d+$/.test(name)).length
  const root = join(ade.root, `p${started + 1}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  return join(root, 'data')
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
