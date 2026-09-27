import { handle } from './ipc'
import { randomUUID } from 'node:crypto'
import {
  dailyUseCommand,
  decodeDailyUseResponse,
  requestDaemon,
  takesOperationId,
  type DailyUseRequest,
  type DailyUseResponse,
} from '@ade/client'
import {
  isAllowedOperation,
  scriptOperations,
  serviceOperations,
  type ScriptOperation,
  type ServiceOperation,
} from '../shared/bridge/operations'
import { getClient, getClientGeneration, getSocket, isSwitching } from './profile-connection'
import { validId } from './validation'

/** Checks a service or listener reply against its contract. */
function serviceReply<O extends ServiceOperation>(op: O, response: unknown): DailyUseResponse<O> {
  try {
    return decodeDailyUseResponse(op, response)
  } catch (error) {
    throw new Error(`Daemon ${op} reply failed its contract: ${String(error)}`)
  }
}
export function registerServiceIpc(): void {
  handle('ade:script-request', async (_event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(scriptOperations, op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid script request')
    }
    const args = fields as Record<string, unknown>
    if (isSwitching() && (op === 'script.start' || op === 'script.stop' || op === 'script.retire')) {
      throw new Error('Profile switch is in progress; retry the script action in the selected profile')
    }
    const endpoint = getSocket()
    const generation = getClientGeneration()
    const state = getClient().getState()
    if (state.status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
    if (!validId(args.workspace_id) || !state.catalog?.workspaces.some((item) => item.id === args.workspace_id)) {
      throw new Error('Workspace is unavailable in this profile')
    }
    const request: Record<string, unknown> = { workspace_id: args.workspace_id }
    const keys = new Set(['workspace_id'])
    if (op === 'script.start') {
      if (typeof args.name !== 'string' || !/^[a-zA-Z0-9_:-][a-zA-Z0-9_.:-]{0,63}$/.test(args.name)) {
        throw new Error('Invalid script name')
      }
      request.name = args.name
      keys.add('name')
    }
    if (op === 'script.inspect' || op === 'script.stop' || op === 'script.retire') {
      if (typeof args.run_id !== 'string' || !/^script_[a-zA-Z0-9_.:-]+_[a-fA-F0-9-]{36}$/.test(args.run_id)) {
        throw new Error('Invalid script run ID')
      }
      request.run_id = args.run_id
      keys.add('run_id')
    }
    if (op === 'script.inspect') {
      if (
        !Number.isSafeInteger(args.tail_bytes) ||
        (args.tail_bytes as number) < 1 ||
        (args.tail_bytes as number) > 32768
      ) {
        throw new Error('Invalid script output limit')
      }
      request.tail_bytes = args.tail_bytes
      keys.add('tail_bytes')
    }
    if (Object.keys(args).some((key) => !keys.has(key))) throw new Error('Unknown script request field')
    const result = await dailyUseCommand(endpoint, { ...request, op } as DailyUseRequest<ScriptOperation>)
    if (generation !== getClientGeneration() || getSocket() !== endpoint) {
      throw new Error(
        'Profile changed while the script request completed; inspect the original profile before retrying',
      )
    }
    return result
  })
  handle('ade:service-request', async (_event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(serviceOperations, op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid service request')
    }
    const args = fields as Record<string, unknown>
    if (
      isSwitching() &&
      ![
        'service.list',
        'service.inspect',
        'service.proxy.inspect',
        'service.proxy.recovery.inspect',
        'listener.list',
      ].includes(op)
    ) {
      throw new Error('Profile switch is in progress; retry the service action in the selected profile')
    }
    const endpoint = getSocket()
    const generation = getClientGeneration()
    const state = getClient().getState()
    if (state.status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
    if (op === 'listener.list') {
      if (Object.keys(args).length) throw new Error('Listener inventory does not accept fields')
      const result = await requestDaemon(endpoint, op, {})
      if (generation !== getClientGeneration() || getSocket() !== endpoint)
        throw new Error('Profile changed while observing listeners')
      return serviceReply(op, result)
    }
    if (op === 'service.proxy.recovery.inspect' || op === 'service.proxy.recovery.reset') {
      const request: Record<string, unknown> = {}
      if (op === 'service.proxy.recovery.inspect' && Object.keys(args).length) {
        throw new Error('URL recovery inspection does not accept fields')
      }
      if (op === 'service.proxy.recovery.reset') {
        if (
          Object.keys(args).sort().join(',') !== 'confirm_reset,expected_registry_sha256' ||
          args.confirm_reset !== true ||
          typeof args.expected_registry_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(args.expected_registry_sha256)
        ) {
          throw new Error('Reset requires confirmation and the inspected registry SHA-256')
        }
        request.expected_registry_sha256 = args.expected_registry_sha256
        request.operation_id = randomUUID()
      }
      const result = await requestDaemon(endpoint, op, request)
      if (generation !== getClientGeneration() || getSocket() !== endpoint) {
        throw new Error('Profile changed while URL recovery completed; inspect the original profile before retrying')
      }
      return serviceReply(op, result)
    }
    if (!validId(args.workspace_id) || !state.catalog?.workspaces.some((item) => item.id === args.workspace_id)) {
      throw new Error('Workspace is unavailable in this profile')
    }
    const request: Record<string, unknown> = { workspace_id: args.workspace_id }
    if (op !== 'service.list') {
      if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80)
        throw new Error('Invalid service name')
      request.name = args.name
    }
    if (op === 'service.configure' || op === 'service.remove') {
      if (!Number.isSafeInteger(args.revision) || (args.revision as number) < 0)
        throw new Error('Invalid service revision')
      request.revision = args.revision
    }
    if (op === 'service.configure') {
      if (!args.config || typeof args.config !== 'object' || Array.isArray(args.config))
        throw new Error('Invalid service configuration')
      request.config = args.config
    }
    if (
      op === 'service.proxy.ensure' ||
      op === 'service.proxy.inspect' ||
      op === 'service.proxy.remap' ||
      op === 'service.proxy.retire' ||
      op === 'service.proxy.recovery.retry'
    ) {
      if (typeof args.port_variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(args.port_variable)) {
        throw new Error('Invalid service port variable')
      }
      request.port_variable = args.port_variable
    }
    if (op === 'service.proxy.remap' || op === 'service.proxy.retire' || op === 'service.proxy.recovery.retry') {
      if (
        typeof args.expected_service_identity !== 'string' ||
        !validId(args.expected_service_identity) ||
        !Number.isSafeInteger(args.expected_target_port) ||
        (args.expected_target_port as number) < 1 ||
        (args.expected_target_port as number) > 65535 ||
        (op === 'service.proxy.remap' &&
          (typeof args.expected_route_identity !== 'string' ||
            !validId(args.expected_route_identity) ||
            !Number.isSafeInteger(args.expected_route_port) ||
            (args.expected_route_port as number) < 1 ||
            (args.expected_route_port as number) > 65535)) ||
        (op !== 'service.proxy.remap' &&
          (typeof args.expected_route_id !== 'string' ||
            !validId(args.expected_route_id) ||
            !Number.isSafeInteger(args.expected_proxy_port) ||
            (args.expected_proxy_port as number) < 1 ||
            (args.expected_proxy_port as number) > 65535))
      ) {
        throw new Error('Invalid expected service targets')
      }
      request.expected_service_identity = args.expected_service_identity
      request.expected_target_port = args.expected_target_port
      if (op === 'service.proxy.remap') {
        request.expected_route_identity = args.expected_route_identity
        request.expected_route_port = args.expected_route_port
      } else {
        request.expected_route_id = args.expected_route_id
        request.expected_proxy_port = args.expected_proxy_port
      }
    }
    if (op === 'service.inspect') {
      if (
        !Number.isSafeInteger(args.tail_bytes) ||
        (args.tail_bytes as number) < 1 ||
        (args.tail_bytes as number) > 32768
      ) {
        throw new Error('Invalid service output limit')
      }
      request.tail_bytes = args.tail_bytes
      if (args.health_check !== undefined) {
        const check = args.health_check
        if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error('Invalid HTTP health check')
        const fields = check as Record<string, unknown>
        if (
          typeof fields.port_variable !== 'string' ||
          typeof fields.path !== 'string' ||
          !Number.isSafeInteger(fields.timeout_ms)
        )
          throw new Error('Invalid HTTP health check')
        request.health_check = { port_variable: fields.port_variable, path: fields.path, timeout_ms: fields.timeout_ms }
      }
    }
    if (takesOperationId(op)) request.operation_id = randomUUID()
    const result = await requestDaemon(endpoint, op, request)
    if (generation !== getClientGeneration() || getSocket() !== endpoint) {
      throw new Error(
        'Profile changed while the service request completed; inspect the original profile before retrying',
      )
    }
    return serviceReply(op, result)
  })
}
