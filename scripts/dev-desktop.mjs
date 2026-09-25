import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const build = spawnSync('node', [join(root, 'scripts/cargo.mjs'), 'build', '--locked',
  '-p', 'ade-daemon', '-p', 'ade-runtime', '--features', 'ade-runtime/native-terminal', '--bins'], {
  cwd: root,
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

const profile = join(root, '.ade/dev-runtime')
const launcher = spawnSync('python3', [join(root, 'scripts/runtime.py'), 'start',
  '--home', profile, '--daemon', join(root, 'target/debug/ade-daemon')], {
  cwd: root,
  env: { ...process.env, ADE_ROOT: root },
  encoding: 'utf8',
})
if (launcher.status !== 0) {
  console.error(launcher.stderr || launcher.error?.message || 'ADE daemon did not start')
  process.exit(launcher.status ?? 1)
}

let connection
try {
  connection = JSON.parse(launcher.stdout)
} catch {
  console.error(`ADE launcher returned an invalid response: ${launcher.stdout}`)
  process.exit(1)
}
if (typeof connection.socket !== 'string' || !existsSync(connection.socket)) {
  console.error('ADE launcher did not provide a daemon socket')
  process.exit(1)
}
console.info(`ADE development profile: ${profile}`)
console.info(`ADE daemon socket: ${connection.socket}`)

const desktop = spawn('pnpm', ['--filter', '@ade/desktop', 'dev'], {
  cwd: root,
  env: { ...process.env, ADE_SOCKET: connection.socket, ADE_RUNTIME_HOME: profile },
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => desktop.kill(signal))
}
desktop.once('error', (error) => {
  console.error(`Could not start Electron development mode: ${error.message}`)
  process.exitCode = 1
})
desktop.once('exit', (code) => { process.exitCode = code ?? 1 })
