import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const extra = [join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin']
const searchPath = [...extra.filter(existsSync), process.env.PATH ?? ''].join(':')
const result = spawnSync('cargo', process.argv.slice(2), {
  env: { ...process.env, PATH: searchPath },
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Cargo is unavailable: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
