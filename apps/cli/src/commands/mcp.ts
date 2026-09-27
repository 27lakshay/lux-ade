import { readFileSync } from 'node:fs'
import { decodeDailyUseResponse, requestDaemon, type DailyUseOperation, type DailyUseResponse } from '@ade/client'
import { CliError, jsonObject, required, type CommandResult } from '../shared.js'

export const mcpUsage = `  mcp list                              List the profile's MCP catalog
  mcp inspect NAME                      Show one entry and how each provider can express it
  mcp add NAME DEFINITION               Record a server once for the profile
  mcp update NAME EXPECTED_REVISION DEFINITION
                                        Replace an entry only at the revision you saw
  mcp remove NAME EXPECTED_REVISION     Delete an entry only at the revision you saw
  mcp resolve WORKSPACE_ID PROVIDER     Show the servers and native config a provider would get
                                        DEFINITION is a JSON object or @FILE; store secrets as
                                        {"env":"VARIABLE"} references, never as values
`

function revision(value: string | undefined): number {
  const number = Number(required(value, 'EXPECTED_REVISION'))
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliError('usage', 'EXPECTED_REVISION must be a nonnegative integer.')
  }
  return number
}

function definition(value: string | undefined): Record<string, unknown> {
  const text = required(value, 'DEFINITION')
  if (!text.startsWith('@')) return jsonObject(text, 'DEFINITION')
  try { return jsonObject(readFileSync(text.slice(1), 'utf8'), 'DEFINITION') }
  catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('usage', `Cannot read DEFINITION file ${text.slice(1)}.`)
  }
}

async function mcpRequest<O extends DailyUseOperation>(socketPath: string, op: O,
  fields: Record<string, unknown> = {}): Promise<DailyUseResponse<O>> {
  const response = await requestDaemon(socketPath, op, fields)
  try { return decodeDailyUseResponse(op, response) }
  catch (error) { throw new CliError('protocol', `Daemon ${op} reply failed its contract: ${String(error)}`) }
}

function arity(action: string, rest: string[], count: number, names: string): void {
  if (rest.length !== count) throw new CliError('usage', `mcp ${action} requires ${names}.`)
}

export async function runMcpCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'mcp') return undefined
  switch (action) {
    case 'list':
      if (rest.length) throw new CliError('usage', 'mcp list does not accept arguments.')
      return mcpRequest(socketPath, 'mcp.server.list')
    case 'inspect':
      arity(action, rest, 1, 'NAME')
      return mcpRequest(socketPath, 'mcp.server.inspect', { name: required(rest[0], 'NAME') })
    case 'add':
      arity(action, rest, 2, 'NAME DEFINITION')
      return mcpRequest(socketPath, 'mcp.server.add', {
        name: required(rest[0], 'NAME'), definition: definition(rest[1]),
      })
    case 'update':
      arity(action, rest, 3, 'NAME EXPECTED_REVISION DEFINITION')
      return mcpRequest(socketPath, 'mcp.server.update', {
        name: required(rest[0], 'NAME'), expected_revision: revision(rest[1]), definition: definition(rest[2]),
      })
    case 'remove':
      arity(action, rest, 2, 'NAME EXPECTED_REVISION')
      return mcpRequest(socketPath, 'mcp.server.remove', {
        name: required(rest[0], 'NAME'), expected_revision: revision(rest[1]),
      })
    case 'resolve':
      arity(action, rest, 2, 'WORKSPACE_ID PROVIDER')
      return mcpRequest(socketPath, 'mcp.resolve', {
        workspace_id: required(rest[0], 'WORKSPACE_ID'), provider: required(rest[1], 'PROVIDER'),
      })
    default:
      return undefined
  }
}
