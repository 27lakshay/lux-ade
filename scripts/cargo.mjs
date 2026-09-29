import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const extra = [join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin']
const searchPath = [...extra.filter(existsSync), process.env.PATH ?? ''].join(':')
const env = { ...process.env, PATH: searchPath }

// Share compiled dependencies across worker worktrees, which each keep their own target/.
if (env.SCCACHE_DISABLE !== '1' && !env.RUSTC_WRAPPER && spawnSync('sccache', ['--version'], { env }).status === 0) {
  env.RUSTC_WRAPPER = 'sccache'
}

// Up to 10 worker worktrees build at once, so a worker gets a bounded share of the CPUs.
const gitDir = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).stdout.trim()
const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim()
if (!env.CARGO_BUILD_JOBS && gitDir && gitDir !== commonDir) {
  env.CARGO_BUILD_JOBS = env.ADE_WORKER_CARGO_JOBS ?? '3'
}

const result = spawnSync('cargo', process.argv.slice(2), { env, stdio: 'inherit' })

if (result.error) {
  console.error(`Cargo is unavailable: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
