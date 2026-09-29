import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'

// Darwin can report EPERM for a process group containing only unreaped zombies.
// Confirm there are no live members; a permission error for a live group still fails.
function groupFinished(error, pid) {
  if (error.code === 'ESRCH') return true
  if (error.code !== 'EPERM' || process.platform !== 'darwin') return false
  const result = spawnSync('ps', ['-ax', '-o', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 })
  if (result.status !== 0) return false
  return result.stdout
    .trim()
    .split('\n')
    .every((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line)
      return match && (Number(match[1]) !== pid || match[2].startsWith('Z'))
    })
}

// Forward cancellation to the runner and its fixture processes, then bound teardown.
export function runCommand({ command, args, cwd, logFile }, env, signals = process) {
  return new Promise((resolveResult) => {
    const grouped = process.platform !== 'win32'
    const log = logFile ? openSync(logFile, 'w') : null
    let remaining = 1024 * 1024
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: logFile ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      detached: grouped,
    })
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream?.on('data', (chunk) => {
        output.write(chunk)
        if (log !== null && remaining > 0) {
          const kept = chunk.subarray(0, remaining)
          writeSync(log, kept)
          remaining -= kept.length
        }
      })
    }
    let cancelled
    let timer
    let cancellationDeadline
    const kill = (signal) => {
      if (!child.pid) return
      try {
        if (grouped) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if (!groupFinished(error, child.pid)) throw error
      }
    }
    const interrupt = (signal) => {
      cancelled = signal
      cancellationDeadline ??= Date.now() + 5000
      kill(signal)
      timer ??= setTimeout(() => kill('SIGKILL'), 5000)
    }
    const onInt = () => interrupt('SIGINT')
    const onTerm = () => interrupt('SIGTERM')
    signals.on('SIGINT', onInt)
    signals.on('SIGTERM', onTerm)
    child.on('error', (error) => console.error(error.message))
    child.on('close', async (code, signal) => {
      // A package-manager launcher can exit before the actual test runner.
      // Let that runner finish fixture teardown, including detached runtimes,
      // within the existing cancellation bound before killing its process group.
      if (cancelled && grouped && child.pid) {
        while (Date.now() < cancellationDeadline) {
          try {
            process.kill(-child.pid, 0)
          } catch (error) {
            if (groupFinished(error, child.pid)) break
            throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        kill('SIGKILL')
      }
      clearTimeout(timer)
      if (log !== null) closeSync(log)
      signals.off('SIGINT', onInt)
      signals.off('SIGTERM', onTerm)
      resolveResult(cancelled === 'SIGINT' ? 130 : cancelled || signal ? 143 : (code ?? 1))
    })
  })
}
