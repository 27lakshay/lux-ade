import { call } from '@ade/client'
import { CliError, type CommandResult } from '../shared.js'

export const settingsUsage = `  settings get                          Read the profile's settings
  settings set KEY VALUE [KEY VALUE ...]
                                        Change settings: appearance light|dark|system,
                                        reduced_motion system|on|off
`

export async function runSettingsCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'settings') return undefined
  if (action === 'get') {
    if (rest.length) throw new CliError('usage', 'settings get does not accept arguments.')
    return call(socketPath, 'settings.get', {})
  }
  if (action === 'set') {
    if (!rest.length || rest.length % 2) throw new CliError('usage', 'settings set requires KEY VALUE pairs.')
    const change: Record<string, string> = {}
    for (let index = 0; index < rest.length; index += 2) change[rest[index]!] = rest[index + 1]!
    return call(socketPath, 'settings.set', change as never)
  }
  return undefined
}
