import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { candidateSource, writeCandidateMetadata } from './package-candidate.mjs'

const root = resolve(import.meta.dirname, '..')
const stage = join(root, '.ade/package-stage')
const providers = join(stage, 'providers')
const bin = join(stage, 'bin')
const cli = join(stage, 'cli')
const client = join(stage, 'client')
const contracts = join(stage, 'contracts')
const bunVersion = '1.3.14'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function inside(directory, candidate) {
  const suffix = relative(directory, candidate)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name)
    visit(filename)
    if (entry.isDirectory()) walk(filename, visit)
  }
}

function validateProvider(folder) {
  const base = join(providers, folder)
  walk(base, (filename) => {
    const source = lstatSync(filename)
    if (source.isSymbolicLink()) {
      const target = realpathSync(filename)
      if (!inside(base, target)) throw new Error(`Provider dependency link escapes its bundle: ${filename}`)
    }
    const parts = relative(base, filename).split(sep)
    if (!source.isFile() || parts.at(-2) !== '.bin') return
    const data = readFileSync(filename, 'utf8')
    if (!data.includes(base)) return
    if (!data.startsWith('#!/bin/sh') || !data.includes('basedir=')) {
      throw new Error(`Provider shim cannot be relocated: ${filename}`)
    }
    const relativeRoot = relative(resolve(filename, '..'), base)
    writeFileSync(filename, data.replaceAll(base, `\${basedir}/${relativeRoot}`))
  })
}

if (process.platform !== 'darwin') throw new Error('package:mac requires macOS')
const source = candidateSource(root)
run('pnpm', ['build'])
run('node', [
  'scripts/cargo.mjs',
  'build',
  '--locked',
  '--release',
  '-p',
  'ade-daemon',
  '-p',
  'ade-runtime',
  '--features',
  'ade-runtime/native-terminal',
  '--bins',
])

// pnpm deploy materializes each provider's pinned production closure, including
// its native optional dependencies, without following development symlinks.
rmSync(stage, { recursive: true, force: true })
mkdirSync(providers, { recursive: true })
mkdirSync(cli, { recursive: true })
mkdirSync(client, { recursive: true })
copyFileSync(join(root, 'apps/cli/package.json'), join(cli, 'package.json'))
copyFileSync(join(root, 'packages/client/package.json'), join(client, 'package.json'))
cpSync(join(root, 'apps/cli/dist'), join(cli, 'dist'), { recursive: true })
cpSync(join(root, 'packages/client/dist'), join(client, 'dist'), { recursive: true })
// @ade/client imports @ade/contracts at run time; the contracts have no runtime dependencies.
mkdirSync(contracts, { recursive: true })
copyFileSync(join(root, 'packages/contracts/package.json'), join(contracts, 'package.json'))
cpSync(join(root, 'packages/contracts/dist'), join(contracts, 'dist'), { recursive: true })
cpSync(join(root, 'packages/contracts/schema'), join(contracts, 'schema'), { recursive: true })
writeFileSync(
  join(stage, 'ade'),
  `#!/bin/sh
set -eu
entry=$0
while [ -L "$entry" ]; do
  link=$(/usr/bin/readlink "$entry")
  case "$link" in
    /*) entry=$link ;;
    *) entry=${'${entry%/*}'}/$link ;;
  esac
done
macos=$(/usr/bin/dirname "$entry")
export ADE_CONTROL_BIN="$macos/ade-control"
export ADE_DAEMON_BIN="$macos/ade-daemon"
export ELECTRON_RUN_AS_NODE=1
exec "$macos/Lux ADE" "$macos/../Resources/cli/dist/index.js" "$@"
`,
  { mode: 0o755 },
)
for (const [packageName, folder] of [
  ['ade-claude-adapter', 'claude'],
  ['ade-codex-worker', 'codex'],
  ['ade-omp-bridge', 'omp'],
]) {
  run('pnpm', [
    '--filter',
    packageName,
    'deploy',
    '--config.inject-workspace-packages=true',
    '--prod',
    '--frozen-lockfile',
    '--ignore-scripts',
    join(providers, folder),
  ])
  copyFileSync(join(root, 'providers', folder, 'package.json'), join(providers, folder, 'package.json'))
  walk(join(providers, folder), (filename) => {
    if (relative(join(providers, folder), filename).split(sep).includes('node_modules')) return
    if (
      filename.endsWith('.test.mjs') ||
      filename.endsWith('fake-sdk.mjs') ||
      filename.endsWith('mock-cli.mjs') ||
      filename.endsWith('transport-fixture.mjs')
    ) {
      rmSync(filename)
    }
  })
  validateProvider(folder)
}
mkdirSync(join(providers, 'codex'), { recursive: true })
for (const name of ['shared-server.mjs'])
  copyFileSync(join(root, 'providers/codex', name), join(providers, 'codex', name))
mkdirSync(join(providers, 'opencode'), { recursive: true })
for (const name of readdirSync(join(root, 'providers/opencode'))) {
  if (!name.endsWith('.mjs') || name.endsWith('.test.mjs') || name.includes('fixture') || name.includes('mock'))
    continue
  copyFileSync(join(root, 'providers/opencode', name), join(providers, 'opencode', name))
}
for (const name of ['plan.mjs', 'tool.mjs']) copyFileSync(join(root, 'providers', name), join(providers, name))
// The backend plugin host (F057); the daemon resolves Resources/packages/plugin-host/src/host.mjs.
const pluginHost = join(stage, 'packages/plugin-host/src')
mkdirSync(pluginHost, { recursive: true })
for (const name of ['host.mjs', 'protocol.mjs'])
  copyFileSync(join(root, 'packages/plugin-host/src', name), join(pluginHost, name))

const bun = realpathSync(
  process.env.ADE_PACKAGE_BUN_BIN || execFileSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim(),
)
if (!statSync(bun).isFile()) throw new Error('A Bun executable is required for Oh My Pi and Codex')
const installedBunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim()
if (installedBunVersion !== bunVersion) throw new Error(`Expected Bun ${bunVersion}, found ${installedBunVersion}`)
mkdirSync(bin, { recursive: true })
copyFileSync(bun, join(bin, 'bun'))
// The bundle's Node for provider bridges and the plugin host: Electron run as
// Node. ELECTRON_RUN_AS_NODE is set here, for this process only, so it never
// reaches the daemon's environment and so never a terminal, service or tool.
writeFileSync(
  join(bin, 'ade-node'),
  `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "\${0%/*}/../../MacOS/Lux ADE" "$@"
`,
  { mode: 0o755 },
)
run('pnpm', ['exec', 'electron-builder', '--mac', '--dir', '--publish', 'never', '--config', 'electron-builder.yml'])
if (candidateSource(root).sourceSha256 !== source.sourceSha256)
  throw new Error('Source changed while packaging; candidate identity was not published. Rebuild from stable source.')
writeCandidateMetadata(
  join(root, `dist/electron/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Lux ADE.app`),
  source,
)
