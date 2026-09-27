import { call, isOperation, operations, type CallRequest, type Operation } from '@ade/client'
import { CliError, jsonObject, required, type CommandResult } from '../shared.js'

export const requestUsage = `  operations [DOMAIN]                   List every daemon operation with its domain and tier
  request OP [JSON_OBJECT]              Call any operation; the request and reply are checked
                                        against its contract, and a reply that fails the check
                                        exits protocol with delivery unknown
`

/** `operations` discovers the command API; `request` calls any operation through the typed SDK call. */
export async function runRequestCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'request') {
    if (rest.length > 1) throw new CliError('usage', 'request accepts OP [JSON_OBJECT].')
    const op = required(action, 'OP')
    if (!isOperation(op)) throw new CliError('usage', `Unknown operation ${op}. Run ade operations to list them.`)
    return call(socketPath, op, (rest[0] ? jsonObject(rest[0], 'JSON_OBJECT') : {}) as CallRequest<Operation>)
  }
  return undefined
}

/** The operation catalog needs no daemon, so `operations` runs before a profile is selected. */
export function listOperations(words: string[]): CommandResult | undefined {
  if (words[0] !== 'operations') return undefined
  if (words.length > 2) throw new CliError('usage', 'operations accepts [DOMAIN].')
  const domain = words[1]
  const listed = Object.entries(operations)
    .filter(([, spec]) => domain === undefined || spec.domain === domain)
    .map(([name, spec]) => ({ name, domain: spec.domain, tier: spec.tier }))
  if (domain !== undefined && listed.length === 0) throw new CliError('usage', `No operations in domain ${domain}.`)
  return { type: 'operations', operations: listed }
}
