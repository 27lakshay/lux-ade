import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const daemonBinary = join(root, 'target/debug/ade-daemon')
const build = spawnSync('node', [join(root, 'scripts/cargo.mjs'), 'build', '--locked',
  '-p', 'ade-daemon', '-p', 'ade-runtime', '--features', 'ade-runtime/native-terminal', '--bins'], {
  cwd: root,
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

const environment = { ...process.env, ADE_DAEMON_BIN: daemonBinary }
if (!environment.ADE_SOCKET) {
  const profilesHome = environment.ADE_PROFILES_HOME ?? join(root, '.ade/dev-profiles')
  environment.ADE_PROFILES_HOME = profilesHome
  const profileScript = join(root, 'scripts/profiles.py')
  const runProfiles = (...args) => spawnSync('python3', [profileScript, '--home', profilesHome, ...args], {
    cwd: root, env: environment, encoding: 'utf8',
  })
  const listed = runProfiles('list')
  if (listed.status !== 0) {
    console.error(listed.stderr || listed.error?.message || 'Could not list ADE profiles')
    process.exit(listed.status ?? 1)
  }
  let profiles
  try { profiles = JSON.parse(listed.stdout) }
  catch { console.error('ADE profile launcher returned an invalid list'); process.exit(1) }
  if (!Array.isArray(profiles.profiles)) {
    console.error('ADE profile launcher returned an invalid list')
    process.exit(1)
  }
  if (profiles.profiles.length === 0) {
    const created = runProfiles('create', 'Development')
    if (created.status !== 0) {
      console.error(created.stderr || created.error?.message || 'Could not create ADE development profile')
      process.exit(created.status ?? 1)
    }
  }
  console.info(`ADE development profiles: ${profilesHome}`)
} else {
  console.info(`ADE explicit daemon socket: ${environment.ADE_SOCKET}`)
}

const desktop = spawn('pnpm', ['--filter', '@ade/desktop', 'dev'], {
  cwd: root,
  env: environment,
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
