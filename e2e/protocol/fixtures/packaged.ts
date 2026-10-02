// The installed macOS bundle (`pnpm package:mac`), run the way a user's Mac
// runs it: the bundle's own `ade`, `ade-control`, `ade-daemon` and
// `ade-runtime`, with PATH=/usr/bin:/bin, a scratch HOME, and no node, cargo,
// pnpm or repository path in the environment. No Electron window opens; the
// bundle's Electron binary runs only as Node, as the bundled CLI runs it.
//
// Import `test` from this file to get `host`: a managed-profile host whose
// launcher is the bundle. Explicit package execution fails when no bundle has been built.
//
// Machine safety: a release daemon refuses the test-only file secret store,
// so a packaged daemon's secret store is the Keychain. It reaches the Keychain
// only to resolve or store a credential reference (services, plugins, remote
// pairing, provider accounts). Packaged specs create none, so no packaged
// process calls the Security framework. `packagedEnvironment` refuses
// ADE_KEYCHAIN and ADE_SECRET_* so nothing can point one at a keychain.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { repositoryRoot } from './environment'
import { test as base } from './index'
import { ProfileHost, type Launcher } from './managed-profiles'
import { mockDirectory } from './providers'

export { expect } from './index'

const packagedApp = resolve(
  process.env.ADE_E2E_PACKAGE_APP ?? join(repositoryRoot, 'dist/electron/mac-arm64/Lux ADE.app'),
)

/** Paths inside a bundle at `app`. */
export function bundlePaths(app: string) {
  return {
    app,
    macos: join(app, 'Contents/MacOS'),
    resources: join(app, 'Contents/Resources'),
    infoPlist: join(app, 'Contents/Info.plist'),
    /** The Electron executable; with ELECTRON_RUN_AS_NODE=1 it is the bundle's Node. */
    electron: join(app, 'Contents/MacOS/Lux ADE'),
    cli: join(app, 'Contents/MacOS/ade'),
    control: join(app, 'Contents/MacOS/ade-control'),
    daemon: join(app, 'Contents/MacOS/ade-daemon'),
    runtime: join(app, 'Contents/MacOS/ade-runtime'),
    bun: join(app, 'Contents/Resources/bin/bun'),
    /** The bundle's Node for provider workers and plugins: runs `electron` with ELECTRON_RUN_AS_NODE=1. */
    node: join(app, 'Contents/Resources/bin/ade-node'),
  }
}
export type BundlePaths = ReturnType<typeof bundlePaths>

/** The bundle under test: ADE_E2E_PACKAGE_APP, or the one `pnpm package:mac` builds. */
export const bundle = bundlePaths(packagedApp)

/**
 * A copy of the bundle at `app`, as a user's drag to another folder makes it.
 * The executables and Resources/bin are APFS clones (`cp -c`), so they run
 * from the new path; the other Resources entries and Frameworks are symlinks
 * to the original, since cloning 60,000 dependency files proves nothing more.
 */
export async function relocateBundle(app: string): Promise<BundlePaths> {
  const moved = bundlePaths(app)
  await mkdir(moved.macos, { recursive: true })
  await mkdir(join(moved.resources, 'bin'), { recursive: true })
  for (const name of await readdir(bundle.macos)) await clone(join(bundle.macos, name), join(moved.macos, name))
  for (const name of await readdir(join(bundle.resources, 'bin'))) {
    await clone(join(bundle.resources, 'bin', name), join(moved.resources, 'bin', name))
  }
  for (const name of await readdir(bundle.resources)) {
    if (name !== 'bin') await symlink(join(bundle.resources, name), join(moved.resources, name))
  }
  for (const name of await readdir(join(bundle.app, 'Contents'))) {
    if (name !== 'MacOS' && name !== 'Resources')
      await symlink(join(bundle.app, 'Contents', name), join(app, 'Contents', name))
  }
  return moved
}

function clone(from: string, to: string): Promise<void> {
  return new Promise((resolveClone, rejectClone) => {
    execFile('/bin/cp', ['-c', '-p', from, to], (error) => (error ? rejectClone(error) : resolveClone()))
  })
}

/** Why packaged specs cannot run, or null when the bundle is there. */
export const bundleMissing: string | null = [
  bundle.cli,
  bundle.control,
  bundle.daemon,
  bundle.runtime,
  bundle.electron,
  bundle.node,
].every((path) => existsSync(path))
  ? null
  : `No packaged app at ${packagedApp}; run pnpm package:mac first`

/** The only PATH packaged processes start with: no node, cargo, pnpm or bun. */
export const minimalPath = '/usr/bin:/bin'

/** A clean environment rooted at `home`: none of the caller's variables, only what a login session provides. */
export function packagedEnvironment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: minimalPath,
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? '/tmp/',
    USER: process.env.USER ?? 'ade',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'ade',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  }
  for (const name of Object.keys(env)) {
    if (name === 'ADE_KEYCHAIN' || name.startsWith('ADE_SECRET_')) {
      throw new Error(`A packaged spec must not set ${name} (machine safety, AGENTS.md)`)
    }
  }
  return env
}

// A stand-in for the user's Codex CLI. The bundle's shared-server.mjs, run by
// the Bun the daemon chose, starts it as `codex app-server --listen unix://…`;
// it relays that WebSocket to the deterministic stdio mock. It records which
// process started it, so a spec can prove the bundle's Bun and relay ran.
const codexServer = `
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
const endpoint = process.argv[process.argv.indexOf('--listen') + 1];
if (!endpoint?.startsWith('unix://')) throw new Error('Expected a Codex Unix endpoint');
mkdirSync(process.env.ADE_MOCK_DIR, { recursive: true });
const parent = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim();
appendFileSync(process.env.ADE_MOCK_DIR + '/launch.jsonl', JSON.stringify({ pid: process.pid, parent, path: process.env.PATH }) + '\\n');
const child = spawn('/usr/bin/python3', [process.env.ADE_E2E_CODEX_MOCK], { stdio: ['pipe', 'pipe', 'inherit'] });
let peer, pending = '';
child.stdout.on('data', (bytes) => {
  pending += bytes.toString();
  let boundary;
  while ((boundary = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
    if (line) peer?.send(line);
  }
});
const server = Bun.serve({ unix: endpoint.slice('unix://'.length),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade failed', { status: 400 }); },
  websocket: {
    open(socket) { peer = socket; },
    message(_socket, data) { child.stdin.write(String(data) + '\\n'); },
    close() { child.kill('SIGTERM'); },
  },
});
process.on('SIGTERM', () => { child.kill('SIGTERM'); server.stop(); process.exit(0); });
`

/**
 * The Claude SDK module ADE_E2E_CLAUDE_SDK names: it records the Node the bundle's own
 * Claude worker runs under, then serves the deterministic SDK double staged beside it.
 */
const claudeSdk = `
import { appendFileSync, mkdirSync } from 'node:fs';
const directory = process.env.ADE_CLAUDE_WORKER_TEST_DIR;
mkdirSync(directory, { recursive: true });
appendFileSync(directory + '/launch.jsonl', JSON.stringify({ pid: process.pid, execPath: process.execPath,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, path: process.env.PATH }) + '\\n');
export * from './worker-test-sdk.mjs';
`

/** Copy the provider fixtures out of the repository so no packaged process reads the checkout. */
export async function stageProviderFixtures(
  directory: string,
  paths: BundlePaths = bundle,
): Promise<Launcher['providers']> {
  await mkdir(directory, { recursive: true })
  const codexMock = join(directory, 'codex_mock.py')
  const server = join(directory, 'codex-unix-server.mjs')
  const codexCli = join(directory, 'codex')
  const sdk = join(directory, 'claude-sdk.mjs')
  await copyFile(join(repositoryRoot, 'scripts/fixtures/codex_mock.py'), codexMock)
  // Packaging leaves the SDK double out of the bundle, so it is staged here.
  for (const name of ['worker-test-sdk.mjs', 'worker-test-store.mjs', 'worker-test-scenarios.mjs'])
    await copyFile(join(repositoryRoot, 'providers/claude', name), join(directory, name))
  await writeFile(server, codexServer)
  await writeFile(codexCli, `#!/bin/sh\nexec '${paths.bun}' '${server}' "$@"\n`, { mode: 0o755 })
  await writeFile(sdk, claudeSdk)
  return (profileRoot) => ({
    ADE_CODEX_BIN: codexCli,
    ADE_E2E_CODEX_MOCK: codexMock,
    ADE_MOCK_DIR: mockDirectory(profileRoot, 'codex'),
    ADE_E2E_CLAUDE_SDK: sdk,
    ADE_CLAUDE_WORKER_TEST_DIR: mockDirectory(profileRoot, 'claude'),
  })
}

/** The bundle as a managed-profile launcher, with provider fixtures staged under `directory`. */
export async function packagedLauncher(directory: string, paths: BundlePaths = bundle): Promise<Launcher> {
  return {
    control: paths.control,
    cli: [paths.cli],
    env: ({ userHome, profilesHome }) => packagedEnvironment(userHome, { ADE_PROFILES_HOME: profilesHome }),
    providers: await stageProviderFixtures(directory, paths),
  }
}

export const test = base.extend<{ host: ProfileHost }>({
  host: async ({ ade }, use, testInfo) => {
    const host = await ProfileHost.create(ade, await packagedLauncher(join(ade.root, 'fixtures')))
    await use(host)
    await host.teardown(testInfo)
  },
})
