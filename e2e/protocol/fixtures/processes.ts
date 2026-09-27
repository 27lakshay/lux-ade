// The process ledger: every process a test owns, so teardown can prove none
// is left running. Roots are the daemons the fixture spawns and the runtimes
// they report; `sweep` adds whatever those roots have started since.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ProcessRow = { pid: number; ppid: number; pgid: number; state: string; command: string }
export type OwnedProcess = { pid: number; role: string; command: string }

export async function processTable(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,state=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  })
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        state: match[4],
        command: match[5],
      })
  }
  return rows
}

/**
 * True while `pid` runs. A killed child its parent has not reaped yet is a
 * zombie: signal 0 still reaches it, so the process table decides.
 */
export async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const state = await execFileAsync('ps', ['-o', 'state=', '-p', String(pid)]).then(
    ({ stdout }) => stdout.trim(),
    () => '',
  )
  return state !== '' && !state.startsWith('Z')
}

export class ProcessLedger {
  private readonly owned = new Map<number, OwnedProcess>()

  /** Record a process this test started or that a process it started reported. */
  async own(pid: number, role: string): Promise<void> {
    if (this.owned.has(pid)) return
    const row = (await processTable()).find((candidate) => candidate.pid === pid)
    if (row) this.owned.set(pid, { pid, role, command: row.command })
  }

  /**
   * Add every live descendant of an owned process, and every member of a
   * process group an owned process leads (the runtime calls setsid, so its
   * children stay in its group after they are reparented).
   */
  async sweep(): Promise<void> {
    const table = await processTable()
    let grew = true
    while (grew) {
      grew = false
      for (const row of table) {
        if (this.owned.has(row.pid) || row.state.startsWith('Z')) continue
        const parent = this.owned.get(row.ppid)
        const leader = row.pgid !== row.pid ? this.owned.get(row.pgid) : undefined
        const owner = parent ?? leader
        if (!owner) continue
        this.owned.set(row.pid, { pid: row.pid, role: `child of ${owner.role}`, command: row.command })
        grew = true
      }
    }
  }

  /** Owned processes still running with the command they were recorded with. */
  async survivors(): Promise<OwnedProcess[]> {
    const table = new Map((await processTable()).map((row) => [row.pid, row]))
    return [...this.owned.values()].filter((owned) => {
      const row = table.get(owned.pid)
      return row !== undefined && !row.state.startsWith('Z') && row.command === owned.command
    })
  }

  all(): OwnedProcess[] {
    return [...this.owned.values()]
  }
}
