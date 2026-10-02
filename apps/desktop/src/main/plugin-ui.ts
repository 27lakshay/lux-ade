import { net, type Session } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dailyUseCommand } from '@ade/client'
import { handle } from './ipc'
import { getClient, getClientGeneration, getSocket } from './profile-connection'
import { contentSecurityPolicy } from '../shared/content-security-policy'
import type { PluginUiEntry } from '../shared/bridge/conversations'

// Plugin UI entry points. The daemon installs and activates plugins; main only serves the UI files
// of each enabled plugin's current activation generation on `ade-plugin://<plugin ID>/<generation>/`
// and tells the renderer which entries to load. A request for another generation, a disabled
// plugin, a path outside the artifact or anything that is not a regular file is refused. Plugin UI
// code is trusted application code; this boundary keeps the right files served, it is not a
// sandbox.

export const PLUGIN_SCHEME = 'ade-plugin'
const CONTENT_SECURITY_POLICY = contentSecurityPolicy()
const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** The artifact each served plugin's current generation runs from. */
const served = new Map<string, { generation: number; root: string }>()

/** The enabled plugins with a UI entry, from the daemon; also what the scheme may serve. */
export async function pluginUiEntries(): Promise<PluginUiEntry[]> {
  const endpoint = getSocket()
  const generation = getClientGeneration()
  if (!endpoint || getClient().getState().status !== 'connected') throw new Error('Profile daemon is unavailable')
  const { plugins } = await dailyUseCommand(endpoint, { op: 'plugin.list' })
  const entries: PluginUiEntry[] = []
  const roots = new Map<string, { generation: number; root: string }>()
  for (const plugin of plugins) {
    if (plugin.status !== 'enabled' || !plugin.activation) continue
    const { plugin: detail } = await dailyUseCommand(endpoint, { op: 'plugin.inspect', plugin_id: plugin.id })
    const ui = detail.manifest.entry_points.ui
    const activation = detail.activation
    if (!ui || !activation || detail.status !== 'enabled' || !isAbsolute(detail.artifact_path)) continue
    roots.set(detail.id, { generation: activation.generation, root: detail.artifact_path })
    entries.push({
      plugin_id: detail.id,
      name: detail.name,
      version: detail.version,
      generation: activation.generation,
      url: `${PLUGIN_SCHEME}://${detail.id}/${activation.generation}/${ui.split('/').map(encodeURIComponent).join('/')}`,
      timeline: detail.manifest.contributes.timeline ?? [],
      composer: detail.manifest.contributes.composer ?? [],
    })
  }
  if (getClientGeneration() !== generation || getSocket() !== endpoint) {
    throw new Error('Profile changed while plugin UI entries were listed')
  }
  served.clear()
  for (const [id, root] of roots) served.set(id, root)
  return entries
}

const refused = (): Response => new Response('Not found', { status: 404 })

/** The file a plugin URL names, or null when it is not one this generation may serve. */
async function servedFile(url: URL): Promise<string | null> {
  const plugin = served.get(url.hostname)
  const [, generation, ...segments] = url.pathname.split('/')
  if (!plugin || generation !== String(plugin.generation) || segments.length === 0) return null
  let parts: string[]
  try {
    parts = segments.map(decodeURIComponent)
  } catch {
    return null
  }
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    return null
  }
  const root = await realpath(plugin.root).catch(() => null)
  if (!root) return null
  const file = await realpath(resolve(root, ...parts)).catch(() => null)
  if (!file) return null
  const inside = relative(root, file)
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) return null
  const info = await stat(file).catch(() => null)
  return info?.isFile() ? file : null
}

/** Serves plugin UI files for one session. The scheme is registered with the app scheme. */
export function servePluginScheme(session: Session): void {
  session.protocol.handle(PLUGIN_SCHEME, async (request) => {
    if (request.method !== 'GET') return refused()
    const file = await servedFile(new URL(request.url))
    if (!file) return refused()
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers({
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      // Module scripts load with CORS from the app origin.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    return new Response(response.body, { status: response.status, headers })
  })
}

export function registerPluginUiIpc(): void {
  handle('ade:plugin-ui-entries', () => pluginUiEntries())
}
