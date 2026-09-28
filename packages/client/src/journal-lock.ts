// A cross-process lock on a client journal directory. A journal keeps its
// records in memory between saves, so two processes sharing one directory (two
// CLI commands at once) would overwrite each other's records.
//
// The lock is a series of generations: `journals.lock.<n>`, each created only
// with an exclusive `link`, so exactly one process can create generation n. The
// highest generation is the current lock. Its holder writes a random token into
// it and touches it every `heartbeatMs`; releasing adds `journals.released.<n>`.
// Generation n is free when it is released, or stale: its process is gone, or
// its heartbeat is older than `staleMs` (which also covers a reused process ID).
// Taking over never deletes the current generation: a taker creates n + 1, and
// only one can. Generations only grow, so a process acting on an old view of
// the directory fails to create its generation, or finds a higher one and backs
// off. A holder only ever removes files below its own generation.
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, stat, unlink, utimes } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const lockPrefix = 'journals.lock.'
const releasedPrefix = 'journals.released.'

export type JournalLockOptions = {
  /** How long to wait for another holder before failing. */
  timeoutMs?: number
  /** How often the holder refreshes its heartbeat. */
  heartbeatMs?: number
  /** A holder whose heartbeat is older than this is gone, whatever its process ID says. */
  staleMs?: number
}

type Holder = { token: string; pid: number }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function generations(names: string[], prefix: string): number[] {
  return names
    .filter((name) => name.startsWith(prefix) && /^[1-9][0-9]*$/.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)))
    .filter(Number.isSafeInteger)
}

async function holder(file: string): Promise<Holder | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<Holder>
    return typeof value.token === 'string' && Number.isSafeInteger(value.pid) ? (value as Holder) : null
  } catch {
    return null
  }
}

/** Whether generation `n` no longer holds the directory. */
async function free(directory: string, names: string[], n: number, staleMs: number): Promise<boolean> {
  if (names.includes(`${releasedPrefix}${n}`)) return true
  const file = join(directory, `${lockPrefix}${n}`)
  const info = await stat(file).catch(() => null)
  // Removed below a newer generation: the caller lists again.
  if (!info) return false
  if (Date.now() - info.mtimeMs > staleMs) return true
  const owner = await holder(file)
  return owner !== null && owner.pid !== process.pid && !alive(owner.pid)
}

/**
 * Takes the journal directory for this process alone. Resolves to the release
 * function, or throws once `timeoutMs` has passed.
 */
export async function lockJournalDirectory(
  directory: string,
  { timeoutMs = 60_000, heartbeatMs = 2_000, staleMs = 30_000 }: JournalLockOptions = {},
): Promise<() => Promise<void>> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('Client journal directory must be absolute')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names = await readdir(directory)
    const current = Math.max(0, ...generations(names, lockPrefix))
    if (current === 0 || (await free(directory, names, current, staleMs))) {
      const mine = current + 1
      const file = join(directory, `${lockPrefix}${mine}`)
      if (await create(directory, file, { token, pid: process.pid })) {
        // Someone acting on an older view may have gone higher; only the highest holds.
        if (Math.max(...generations(await readdir(directory), lockPrefix)) === mine) {
          return hold(directory, file, mine, token, heartbeatMs)
        }
        await unlink(file).catch(() => undefined)
      }
      continue
    }
    if (Date.now() > deadline) throw new Error(`Client journals at ${directory} are in use by another process`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
}

/** Creates `file` holding `owner`, complete, only if no file of that name exists. */
async function create(directory: string, file: string, owner: Holder): Promise<boolean> {
  const temporary = join(directory, `.journals.${owner.token}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(owner))
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function hold(
  directory: string,
  file: string,
  generation: number,
  token: string,
  heartbeatMs: number,
): Promise<() => Promise<void>> {
  // Older generations and their release marks are no longer needed.
  for (const name of await readdir(directory)) {
    const older = [lockPrefix, releasedPrefix].some(
      (prefix) => name.startsWith(prefix) && generations([name], prefix)[0] < generation,
    )
    if (older) await unlink(join(directory, name)).catch(() => undefined)
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(file, now, now).catch(() => undefined)
  }, heartbeatMs)
  heartbeat.unref()
  let released = false
  return async () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    // Only this generation's holder marks it released; a taker never reuses its number.
    if ((await holder(file))?.token !== token) return
    const mark = await open(join(directory, `${releasedPrefix}${generation}`), 'wx', 0o600).catch(() => null)
    await mark?.close()
  }
}
