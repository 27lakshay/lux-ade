import { handle } from './ipc'
import { randomUUID } from 'node:crypto'
import { dailyUseCommand, takesOperationId, type DailyUseRequest } from '@ade/client'
import {
  isAllowedOperation,
  scriptOperations,
  serviceOperations,
  type ScriptOperation,
  type ServiceOperation,
} from '../shared/bridge/operations'
import type { ServicesBridge } from '../shared/bridge/services'
import { getClient, getClientGeneration, getSocket, isSwitching } from './profile-connection'

// Script and service requests from the window, forwarded to the daemon. The SDK checks each request
// against its contract and the daemon checks every value (names, ports, limits, health checks), so
// main adds only what guards the window: the operation is one the renderer may call, and a request
// that changes something never lands in a profile other than the one the window was using.

/** Operations safe to send while the profile is switching: they only read. */
const reads = new Set<string>([
  'script.inspect',
  'service.list',
  'service.inspect',
  'service.proxy.inspect',
  'service.proxy.recovery.inspect',
  'listener.list',
])

async function forward<O extends ScriptOperation | ServiceOperation>(op: O, fields: Record<string, unknown>) {
  if (isSwitching() && !reads.has(op)) throw new Error('Profile switch is in progress; retry in the selected profile')
  const endpoint = getSocket()
  const generation = getClientGeneration()
  if (getClient().getState().status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
  const request = { ...fields, ...(takesOperationId(op) ? { operation_id: randomUUID() } : {}), op }
  const result = await dailyUseCommand(endpoint, request as unknown as DailyUseRequest<O>)
  if (generation !== getClientGeneration() || getSocket() !== endpoint)
    throw new Error('Profile changed while the request completed; inspect the original profile before retrying')
  return result
}

const fieldsOf = (fields: unknown, what: string): Record<string, unknown> => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(`Invalid ${what} request`)
  return fields as Record<string, unknown>
}

export function registerServiceIpc(): void {
  handle('ade:script-request', async (_event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(scriptOperations, op)) throw new Error('Invalid script request')
    return forward(op, fieldsOf(fields, 'script')) as ReturnType<ServicesBridge['requestScript']>
  })
  handle('ade:service-request', async (_event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(serviceOperations, op)) throw new Error('Invalid service request')
    return forward(op, fieldsOf(fields, 'service')) as ReturnType<ServicesBridge['request']>
  })
}
