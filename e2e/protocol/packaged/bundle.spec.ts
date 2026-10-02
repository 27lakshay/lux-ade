// R020, headless part: the installed bundle declares and finds its own
// resources and reports its versions, with no development tooling on PATH.
// Nothing here starts a daemon; see cold-start.spec.ts and cli-turn.spec.ts.
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, symlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { repositoryRoot } from '../fixtures/environment'
import { bundle, bundleMissing, expect, minimalPath, packagedEnvironment, test } from '../fixtures/packaged'

test.beforeAll(() => {
  if (bundleMissing) throw new Error(bundleMissing)
})

type Run = { code: number; stdout: string; stderr: string }
function run(file: string, args: string[], env: Record<string, string>, cwd: string): Promise<Run> {
  return new Promise((resolveRun) => {
    execFile(file, args, { env, cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: number | string }) | null
      resolveRun({ code: failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0, stdout, stderr })
    })
  })
}

async function walk(directory: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    await visit(path)
    if (entry.isDirectory()) await walk(path, visit)
  }
}

async function executable(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  return info !== null && info.isFile() && (info.mode & 0o111) !== 0
}

test('the bundle carries every declared native and provider resource and no test fixture', async () => {
  for (const name of ['ade', 'ade-control', 'ade-daemon', 'ade-runtime', 'Lux ADE']) {
    expect(await executable(join(bundle.macos, name)), name).toBe(true)
  }
  expect(await executable(bundle.bun)).toBe(true)
  expect(await executable(bundle.node)).toBe(true)
  // Every resource the daemon, runtime and CLI resolve relative to Contents/Resources.
  for (const resource of [
    'app.asar',
    'cli/dist/index.js',
    'cli/package.json',
    'cli/node_modules/@ade/client/dist/index.js',
    'cli/node_modules/@ade/contracts/dist/index.js',
    'providers/claude/worker.mjs',
    'providers/claude/package.json',
    'providers/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    'providers/codex/shared-server.mjs',
    'providers/omp/package.json',
    'providers/omp/worker.mjs',
    'providers/acp/worker.mjs',
    'providers/acp/node_modules/@agentclientprotocol/sdk/package.json',
    'providers/plan.mjs',
    'providers/tool.mjs',
    'packages/plugin-host/src/host.mjs',
    'packages/plugin-host/src/protocol.mjs',
  ]) {
    expect((await lstat(join(bundle.resources, resource)).catch(() => null))?.isFile(), resource).toBe(true)
  }

  // Test fixtures and Python scripts are left out; provider code outside node_modules is the product's own.
  const shipped: string[] = []
  await walk(join(bundle.resources, 'providers'), async (path) => {
    const inside = relative(join(bundle.resources, 'providers'), path)
    if (inside.split(sep).includes('node_modules')) return
    shipped.push(inside)
  })
  expect(
    shipped.filter(
      (path) =>
        /(\.test\.mjs|worker-test-[\w-]+\.mjs|mock-cli\.mjs|transport-fixture\.mjs|\.py)$/.test(path) ||
        /mock|fixture/.test(path),
    ),
  ).toEqual([])
  expect((await readdir(bundle.resources)).filter((name) => name.endsWith('.py'))).toEqual([])
})

test('bundled launchers and provider shims are relocatable and never name the build checkout', async () => {
  const checked: string[] = [bundle.cli]
  for (const provider of ['claude', 'omp', 'acp']) {
    await walk(join(bundle.resources, 'providers', provider, 'node_modules'), async (path) => {
      if (path.split(sep).at(-2) === '.bin' && (await lstat(path)).isFile()) checked.push(path)
    })
  }
  await walk(join(bundle.resources, 'cli'), async (path) => {
    if (/\.(m?js|json)$/.test(path)) checked.push(path)
  })
  await walk(join(bundle.resources, 'packages'), async (path) => {
    if (path.endsWith('.mjs')) checked.push(path)
  })
  expect(checked.length).toBeGreaterThan(3)
  const naming: string[] = []
  for (const path of checked) {
    if ((await readFile(path)).includes(repositoryRoot)) naming.push(relative(bundle.app, path))
  }
  expect(naming).toEqual([])
  const asar = await readFile(join(bundle.resources, 'app.asar'))
  expect(asar.includes(repositoryRoot)).toBe(false)
  expect(asar.includes('/usr/bin/python3')).toBe(false)
})

test('the bundle reports its versions and protocols with no development tooling on PATH', async ({ ade }) => {
  const home = join(ade.root, 'home')
  await mkdir(home, { recursive: true })
  const env = packagedEnvironment(home)

  // The app version is the desktop package's; the bundled CLI is the same release.
  const plist = await readFile(bundle.infoPlist, 'utf8')
  const desktop = JSON.parse(await readFile(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as {
    version: string
  }
  const bundledCli = JSON.parse(await readFile(join(bundle.resources, 'cli/package.json'), 'utf8')) as {
    version: string
  }
  expect(plist).toMatch(
    new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${desktop.version.replaceAll('.', '\\.')}</string>`),
  )
  expect(bundledCli.version).toBe(desktop.version)

  // ade-control reports the protocols it speaks and finds its sibling executables.
  const version = await run(bundle.control, ['version'], env, home)
  expect(version.code, version.stderr).toBe(0)
  const reported = JSON.parse(version.stdout) as Record<string, unknown>
  expect(reported).toMatchObject({ type: 'backend_version', artifacts: { 'ade-daemon': true, 'ade-runtime': true } })
  expect(reported.application_protocol).toMatch(/^ade-application-v\d+$/)
  expect(reported.runtime_protocol).toEqual(expect.any(String))

  // The bundled Bun and bin/ade-node (the bundle's Electron as Node) both run from
  // the minimal PATH, and ade-node sets ELECTRON_RUN_AS_NODE for itself alone.
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  const bun = await run(bundle.bun, ['--version'], env, home)
  expect(bun.code, bun.stderr).toBe(0)
  expect(bun.stdout.trim()).toBe('1.3.14')
  const node = await run(
    bundle.node,
    [
      '-e',
      'console.log(JSON.stringify({node: process.versions.node, electron: process.versions.electron, execPath: process.execPath, path: process.env.PATH}))',
    ],
    env,
    home,
  )
  expect(node.code, node.stderr).toBe(0)
  expect(JSON.parse(node.stdout)).toMatchObject({
    node: expect.any(String),
    electron: expect.any(String),
    execPath: bundle.electron,
    path: minimalPath,
  })

  // The installed CLI runs through a symlink placed elsewhere, as an install in ~/bin would.
  const link = join(ade.root, 'bin', 'ade')
  await mkdir(join(ade.root, 'bin'))
  await symlink(bundle.cli, link)
  const help = await run(link, ['--help'], env, home)
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain('ADE local command line')

  // With no profile registered, profile list answers from the scratch profiles home.
  const listed = await run(link, ['profile', 'list'], { ...env, ADE_PROFILES_HOME: join(ade.root, 'profiles') }, home)
  expect(listed.code, listed.stderr).toBe(0)
  expect(JSON.parse(listed.stdout)).toMatchObject({ type: 'profiles', profiles: [], selected_id: null })
})
