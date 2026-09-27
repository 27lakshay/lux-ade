// The backend gate that replaces E2E until UI work begins (AGENTS.md, test policy).
// It runs every static check plus the legacy Rust tests, stops at the first
// failure and reports how long each step took.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cargo = ['node', 'scripts/cargo.mjs']
const features = ['--features', 'ade-runtime/native-terminal']
const steps = [
  ['rustfmt', [...cargo, 'fmt', '--all', '--check']],
  // The committed packages/contracts must match the Rust contract types.
  ['contract check', ['pnpm', 'contract:check']],
  ['architecture', ['python3', 'scripts/check_architecture.py']],
  // Dependent packages typecheck against the SDK's built declarations.
  ['sdk build', ['pnpm', 'build:sdk']],
  ['typecheck', ['pnpm', 'typecheck']],
  ['fallow', ['pnpm', 'deadcode']],
  ['js build', ['pnpm', 'build']],
  ['clippy', [...cargo, 'clippy', '--locked', '--workspace', ...features, '--all-targets', '--', '-D', 'warnings']],
  ['legacy rust tests', [...cargo, 'nextest', 'run', '--locked', '--workspace', ...features, '--profile', 'ci']],
]

const toolPaths = [resolve(root, '.ade/tools/bin'), join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin']
const env = { ...process.env, PATH: [...toolPaths.filter(existsSync), process.env.PATH ?? ''].join(':') }
for (const [name, [command, ...args]] of steps) {
  const started = Date.now()
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    console.error(`check:static failed at ${name} after ${seconds}s`)
    process.exit(result.status ?? 1)
  }
  console.log(`check:static ${name} passed in ${seconds}s`)
}
