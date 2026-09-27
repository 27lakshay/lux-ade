// Shared steps for the plugin development specs (F060, F139 backend part).
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type ScratchProfile } from '../fixtures'

let operations = 0

export function invoke(profile: ScratchProfile, pluginId: string, commandId: string, args: unknown = null,
  operationId = `plugin-dev-${process.pid}-${++operations}`) {
  return profile.call('plugin.command.invoke', { operation_id: operationId, plugin_id: pluginId, command_id: commandId, args },
    { timeoutMs: 60_000 })
}

export async function echoed(profile: ScratchProfile, pluginId: string) {
  return (await invoke(profile, pluginId, 'e2e.backend.echo')).outcome as
    { status: string; value: { version: string; generation: number; pid: number } }
}

export function generations(profile: ScratchProfile, pluginId: string) {
  return profile.call('plugin.generation.list', { plugin_id: pluginId })
}

/** Each generation as `number:state`, sorted. */
export async function states(profile: ScratchProfile, pluginId: string): Promise<string[]> {
  return (await generations(profile, pluginId)).generations
    .map((generation) => `${generation.generation}:${generation.state}`).sort()
}

export async function current(profile: ScratchProfile, pluginId: string): Promise<number> {
  const live = (await generations(profile, pluginId)).generations.filter((generation) => generation.state === 'current')
  expect(live).toHaveLength(1)
  return live[0].generation
}

/** When the watcher last finished a reload attempt; 0 before the first. */
export async function lastReloadAt(profile: ScratchProfile, pluginId: string): Promise<number> {
  return (await generations(profile, pluginId)).dev?.last_reload?.at ?? 0
}

/** Waits for the reload attempt after `after` and returns it. */
export async function nextReload(profile: ScratchProfile, pluginId: string, after: number, timeout = 20_000) {
  await expect.poll(() => lastReloadAt(profile, pluginId), { timeout }).toBeGreaterThan(after)
  const reload = (await generations(profile, pluginId)).dev?.last_reload
  if (!reload) throw new Error('no reload recorded')
  return reload
}

export async function editFile(source: string, file: string, change: (text: string) => string): Promise<void> {
  const path = join(source, file)
  await writeFile(path, change(await readFile(path, 'utf8')))
}

export function setVersion(source: string, version: string): Promise<void> {
  return editFile(source, 'backend.mjs', (text) => text.replace(/^const VERSION = '.*'$/m, `const VERSION = '${version}'`))
}

export function editManifest(source: string, change: (manifest: Record<string, unknown>) => void): Promise<void> {
  return editFile(source, 'ade-plugin.json', (text) => {
    const manifest = JSON.parse(text) as Record<string, unknown>
    change(manifest)
    return `${JSON.stringify(manifest, null, 2)}\n`
  })
}
