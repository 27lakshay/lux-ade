import { call } from '@ade/client'
import { CliError, type CommandResult } from '../shared.js'

export const settingsUsage = `  settings get                          Read the profile's settings
  settings set KEY VALUE [KEY VALUE ...]
                                        Change settings: appearance light|dark|system,
                                        reduced_motion system|on|off,
                                        keybindings.COMMAND ACCELERATOR|none
  settings reset-keybindings [COMMAND ...]
                                        Return the named commands, or every command,
                                        to their default keys
`

const KEYBINDING = 'keybindings.'

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
    const change: Record<string, unknown> = {}
    const keybindings: Record<string, string | null> = {}
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!
      const value = rest[index + 1]!
      // `none` unbinds the command; it is not an accelerator.
      if (key.startsWith(KEYBINDING)) keybindings[key.slice(KEYBINDING.length)] = value === 'none' ? null : value
      else change[key] = value
    }
    if (Object.keys(keybindings).length) change.keybindings = keybindings
    return call(socketPath, 'settings.set', change as never)
  }
  if (action === 'reset-keybindings') {
    return call(socketPath, 'settings.set', { reset_keybindings: rest.length ? rest : 'all' } as never)
  }
  return undefined
}
