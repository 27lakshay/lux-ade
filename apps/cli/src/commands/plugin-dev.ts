import { dailyUseCommand } from '@ade/client'
import { CliError, type CommandResult } from '../shared.js'

export const pluginDevUsage = `  plugin dev enter PLUGIN_ID [--debounce-ms N]
                                        Watch a local plugin's source and reload it on change (50 to 10000 ms quiet period)
  plugin dev leave PLUGIN_ID             Stop watching; the last reloaded artifact stays active
  plugin generations PLUGIN_ID           Show activation generations, drains, provider leases and the last reload
`

function debounce(value: string | undefined): { debounce_ms?: number } {
  if (value === undefined) return {}
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || number < 50 || number > 10_000) {
    throw new CliError('usage', '--debounce-ms must be an integer from 50 to 10000.')
  }
  return { debounce_ms: number }
}

function pluginId(words: string[], usage: string): string {
  if (words.length !== 1 || words[0].startsWith('--')) throw new CliError('usage', `${usage}.`)
  return words[0]
}

export async function runPluginDevCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'plugin' || (action !== 'dev' && action !== 'generations')) return undefined
  if (action === 'generations') {
    const plugin_id = pluginId(rest, 'plugin generations requires PLUGIN_ID')
    return dailyUseCommand(socketPath, { op: 'plugin.generation.list', plugin_id })
  }
  const [mode, ...tail] = rest
  if (mode === 'leave') {
    const plugin_id = pluginId(tail, 'plugin dev leave requires PLUGIN_ID')
    return dailyUseCommand(socketPath, { op: 'plugin.dev.leave', plugin_id })
  }
  if (mode === 'enter') {
    const index = tail.indexOf('--debounce-ms')
    const value = index === -1 ? undefined : tail[index + 1]
    if (index !== -1 && value === undefined) throw new CliError('usage', '--debounce-ms requires one value.')
    const words = index === -1 ? tail : tail.filter((_, at) => at !== index && at !== index + 1)
    const plugin_id = pluginId(words, 'plugin dev enter requires PLUGIN_ID [--debounce-ms N]')
    return dailyUseCommand(socketPath, { op: 'plugin.dev.enter', plugin_id, ...debounce(value) })
  }
  throw new CliError('usage', 'plugin dev requires enter or leave.')
}
