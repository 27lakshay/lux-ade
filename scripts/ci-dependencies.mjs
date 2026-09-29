import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRun, runStages } from './run-stages.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const toolPaths = [resolve(root, '.ade/tools/bin'), join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin']
const env = { ...process.env, PATH: [...toolPaths.filter(existsSync), process.env.PATH ?? ''].join(':') }
const directory = process.env.ADE_DEPENDENCY_REPORT_DIR ?? createRun(root, 'dependencies')
process.exitCode = await runStages([['dependency checks', ['bash', 'scripts/check_dependencies.sh']]], {
  root,
  env,
  directory: resolve(directory),
})
