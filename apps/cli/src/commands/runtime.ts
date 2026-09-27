import { call } from '@ade/client'
import { CliError, parseWords, positionals, type CommandResult } from '../shared.js'

export const runtimeUsage = `  runtime status                        Read the daemon and runtime supervisor state and boot ID
  runtime prepare-restart BOOT_ID       Drain the daemon so a new build can take over;
                                        a daemon with a different boot ID refuses
`

export async function runRuntimeCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'runtime') return undefined
  if (action === 'status') {
    positionals(parseWords(rest, [], [], 'runtime status'), 0, 'runtime status does not accept arguments')
    return call(socketPath, 'runtime.status', {})
  }
  if (action === 'prepare-restart') {
    const [boot_id] = positionals(parseWords(rest, [], [], 'runtime prepare-restart'), 1,
      'runtime prepare-restart requires BOOT_ID from runtime status')
    return call(socketPath, 'runtime.prepare_restart', { boot_id })
  }
  throw new CliError('usage', 'Unknown runtime command. Run ade --help for usage.')
}
