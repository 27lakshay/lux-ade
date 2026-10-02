// Finds the native OpenCode installation this worker drives. The plugin owns this
// check because ADE core knows nothing about OpenCode: a missing or incompatible
// executable becomes an `unavailable` operation declaration with this reason.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

const executable = (path) => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The executable, in order: `ADE_OPENCODE_BIN` when set (it is never second-guessed),
 * `opencode` on PATH, then the official installer's `~/.opencode/bin/opencode`.
 */
function locateOpenCode(env = process.env) {
  const configured = env.ADE_OPENCODE_BIN
  if (configured) {
    if (!isAbsolute(configured)) return { found: false, reason: 'ADE_OPENCODE_BIN must be an absolute path' }
    return executable(configured)
      ? { found: true, command: configured, source: 'ADE_OPENCODE_BIN' }
      : { found: false, reason: `OpenCode is not installed at ADE_OPENCODE_BIN (${configured})` }
  }
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue
    const candidate = join(directory, 'opencode')
    if (executable(candidate)) return { found: true, command: candidate, source: 'PATH' }
  }
  const installer = join(env.HOME || homedir(), '.opencode/bin/opencode')
  if (executable(installer)) return { found: true, command: installer, source: 'installer' }
  return {
    found: false,
    reason: 'OpenCode is not installed: no opencode on PATH or at ~/.opencode/bin; install it or set ADE_OPENCODE_BIN',
  }
}

/** Reads `opencode --version` once. Only OpenCode v2 serves the API this worker speaks. */
export function inspectOpenCode(env = process.env) {
  const located = locateOpenCode(env)
  if (!located.found) return { ...located, available: false }
  const result = spawnSync(located.command, ['--version'], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024,
  })
  const version = /\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(result.stdout ?? '')?.[1] ?? null
  if (result.error || result.status !== 0 || !version)
    return { ...located, available: false, version, reason: 'OpenCode did not report its version' }
  if (!version.startsWith('2.'))
    return { ...located, available: false, version, reason: `OpenCode ${version} is not v2; this worker needs v2` }
  return { ...located, available: true, version, reason: '' }
}
