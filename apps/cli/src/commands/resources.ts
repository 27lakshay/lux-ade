import { call } from '@ade/client'
import { CliError, parseWords, positionals, requestIdOption, type CommandResult } from '../shared.js'

export const resourceUsage = `  resources inspect [PATH]              Read the host resource registry and its claims,
                                        or only claims on, inside or containing PATH
  resources resolve CLAIM_ID CONFIRM_PATH --request-id ID
                                        Release one quarantined claim after reconciling it outside ADE;
                                        CONFIRM_PATH must equal the claim's recorded path
  resources accept-registry CONFIRM_REGISTRY --request-id ID
                                        Bind this profile to the registry now on disk; owners known only
                                        to the lost registry are forgotten
`

export async function runResourceCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'resources') return undefined
  if (action === 'inspect') {
    const parsed = parseWords(rest, [], [], 'resources inspect')
    if (parsed.positionals.length > 1) throw new CliError('usage', 'resources inspect accepts [PATH].')
    const path = parsed.positionals[0]
    return call(socketPath, 'resources.inspect', path ? { path } : {})
  }
  if (action === 'resolve') {
    const parsed = parseWords(rest, ['--request-id'], [], 'resources resolve')
    const [claim_id, confirm_path] = positionals(parsed, 2, 'resources resolve requires CLAIM_ID CONFIRM_PATH --request-id ID')
    const operation_id = requestIdOption(parsed, 'resources resolve')
    return call(socketPath, 'resources.claim.resolve', { claim_id, confirm_path, operation_id })
  }
  if (action === 'accept-registry') {
    const parsed = parseWords(rest, ['--request-id'], [], 'resources accept-registry')
    const [confirm_registry] = positionals(parsed, 1, 'resources accept-registry requires CONFIRM_REGISTRY --request-id ID')
    const operation_id = requestIdOption(parsed, 'resources accept-registry')
    return call(socketPath, 'resources.registry.accept', { confirm_registry, operation_id })
  }
  throw new CliError('usage', 'Unknown resources command. Run ade --help for usage.')
}
