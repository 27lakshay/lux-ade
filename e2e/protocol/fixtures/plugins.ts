// Fixture plugins for plugin and provider-plugin specs. The sources live in
// ./plugins/: `backend` is a backend entry with commands, a setting and a
// lifecycle hook; `provider` is a provider worker; `ui` is a provider worker
// with a UI entry point (a timeline renderer and a composer transform; the
// `ui-freeze.mjs` entry hangs its renderer). A spec copies one into its
// temp root, so it may edit the copy (dev-mode reload) without touching the
// checked-in source or another test.
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ScratchProfile } from './profile'
const repositoryRoot = resolve(__dirname, '../../..')
export type FixturePlugin = 'backend' | 'provider' | 'ui'

export const fixturePluginIds: Record<FixturePlugin, string> = {
  backend: 'e2e.backend',
  provider: 'e2e.agent',
  ui: 'e2e.ui',
}

/** The self-contained, prebuilt Effect diagnostic plugin used by install and inspection tests. */
export async function providerSdkDiagnosticArtifact(isolatedRoot: string): Promise<string> {
  const source = join(repositoryRoot, 'packages/provider-sdk/dist/diagnostic-plugin')
  const artifact = join(isolatedRoot, 'provider-sdk-diagnostic')
  await rm(artifact, { recursive: true, force: true })
  await cp(source, artifact, { recursive: true, dereference: true })
  await Promise.all([
    access(join(artifact, 'ade-plugin.json')),
    access(join(artifact, 'examples/diagnostic-worker.mjs')),
    access(join(artifact, 'node_modules/effect/package.json')),
  ])
  return realpath(artifact)
}

/**
 * A private copy of the packaged OpenCode provider plugin (plugins/opencode/artifact,
 * built by `pnpm build:sdk`). It is installed through the ordinary `plugin.install`.
 */
export async function openCodePluginArtifact(isolatedRoot: string): Promise<string> {
  const artifact = join(isolatedRoot, 'opencode-plugin')
  await rm(artifact, { recursive: true, force: true })
  await cp(join(repositoryRoot, 'plugins/opencode/artifact'), artifact, { recursive: true, dereference: true })
  await Promise.all([
    access(join(artifact, 'ade-plugin.json')),
    access(join(artifact, 'dist/worker.js')),
    access(join(artifact, 'node_modules/effect/package.json')),
  ])
  return realpath(artifact)
}

/** The deterministic OpenCode v2 server the fixture tier runs in place of the native binary. */
export const openCodeFixtureServer = join(repositoryRoot, 'plugins/opencode/test/fixtures/mock-opencode.mjs')

/** Environment that points the OpenCode plugin at the fixture server, with its ledger under `root`. */
export function openCodeFixtureEnvironment(root: string): Record<string, string> {
  return { ADE_OPENCODE_BIN: openCodeFixtureServer, ADE_MOCK_OPENCODE_DIR: join(root, 'opencode-fixture') }
}

/** Every request the OpenCode fixture server recorded, oldest first. */
export async function openCodeFixtureCalls(root: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(root, 'opencode-fixture/calls.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

let copies = 0

/** A private copy of a fixture plugin under `root`, optionally with manifest fields replaced. */
export async function stagePlugin(
  root: string,
  plugin: FixturePlugin,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const target = join(root, 'plugin-sources', `${plugin}-${++copies}`)
  await mkdir(join(root, 'plugin-sources'), { recursive: true })
  await cp(join(__dirname, 'plugins', plugin), target, { recursive: true })
  if (Object.keys(manifest).length) {
    const path = join(target, 'ade-plugin.json')
    const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify({ ...current, ...manifest }, null, 2)}\n`)
  }
  return realpath(target)
}

/**
 * Install `source` as a local plugin, enable it, and, for the backend fixture,
 * point its `out_dir` setting at a directory the spec can read.
 * Returns that directory (or '' when the plugin has no backend).
 */
export async function installAndEnable(
  profile: ScratchProfile,
  source: string,
  operationId = `install-${++copies}`,
): Promise<{ pluginId: string; outDir: string }> {
  const installed = await profile.call('plugin.install', {
    operation_id: operationId,
    source: { kind: 'local', path: source },
  })
  const pluginId = installed.plugin.id
  await profile.call('plugin.enable', { plugin_id: pluginId })
  if (!installed.plugin.manifest.entry_points.backend) return { pluginId, outDir: '' }
  const outDir = join(profile.root, 'plugin-out', pluginId)
  await mkdir(outDir, { recursive: true })
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'out_dir', value: outDir })
  return { pluginId, outDir }
}

/** The JSON lines a fixture plugin wrote to `file` in `outDir`; empty before the first. */
export async function pluginLines(outDir: string, file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(outDir, file), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Create the release file a held fixture command or hook waits for. */
export async function releasePlugin(outDir: string, name: string): Promise<void> {
  await writeFile(join(outDir, name), '')
}
