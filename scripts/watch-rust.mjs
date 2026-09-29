import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './test-process.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const command = resolve(root, '.ade/tools/bin/bacon')
if (!existsSync(command)) {
  console.error('Install the optional watcher with: python3 scripts/install_tools.py bacon')
  process.exitCode = 1
} else {
  const paths = [resolve(root, '.ade/tools/bin'), join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin']
  const env = { ...process.env, PATH: [...paths.filter(existsSync), process.env.PATH ?? ''].join(':') }
  process.exitCode = await runCommand({ command, args: process.argv.slice(2), cwd: root }, env)
}
