import { dailyUseCommand, requestDaemon } from '@ade/client'
import { CliError, jsonObject, required, type CommandResult } from '../shared.js'

export const serviceUsage = `  service list WORKSPACE_ID             List managed services and execution state
  service configure WORKSPACE_ID NAME JSON_CONFIG [REVISION]
                                        Save a service recipe; revision defaults to 0
  service start WORKSPACE_ID NAME       Launch a configured service
  service stop WORKSPACE_ID NAME        Stop and reap a managed service
  service inspect WORKSPACE_ID NAME [TAIL_BYTES]
                                        Read execution, listener evidence and bounded output
  service url WORKSPACE_ID NAME PORT_VARIABLE
                                        Ensure a stable local HTTP/WebSocket URL
  service url-inspect WORKSPACE_ID NAME PORT_VARIABLE
                                        Inspect a stable URL and its pinned service identity
  service remap WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_ROUTE_ID EXPECTED_ROUTE_PORT
                                        Remap only if both reviewed targets still match
  service url-retire WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT
                                        Retire exactly one reviewed stable URL
  service url-recovery                    Inspect blocked routes or a corrupt proxy registry
  service url-retry WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT
                                        Rebind only the reviewed route's original port
  service url-recovery-reset EXPECTED_REGISTRY_SHA256 --confirm-reset
                                        Archive and reset an inspected corrupt registry
  script list WORKSPACE_ID               Discover package scripts in a workspace
  script runs WORKSPACE_ID               List retained script runs
  script start WORKSPACE_ID NAME         Run a configured workspace script
  script inspect WORKSPACE_ID RUN_ID [TAIL_BYTES]
                                        Read script state and bounded output
  script stop WORKSPACE_ID RUN_ID        Stop a script and confirm process exit
  script retire WORKSPACE_ID RUN_ID      Release an exited script run
`

export const listenerUsage = `  listener list                         Observe local TCP listeners and service assignments
`

function revision(value: string | undefined): number {
  if (value === undefined) return 0
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new CliError('usage', 'REVISION must be a nonnegative integer.')
  return number
}

function tailBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > 32768) {
    throw new CliError('usage', 'TAIL_BYTES must be an integer from 1 to 32768.')
  }
  return number
}

function port(value: string | undefined, label: string): number {
  const number = Number(value)
  if (!value || !Number.isSafeInteger(number) || number < 1 || number > 65535) {
    throw new CliError('usage', `${label} must be a TCP port from 1 to 65535.`)
  }
  return number
}

function sha256(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new CliError('usage', 'EXPECTED_REGISTRY_SHA256 must be 64 lowercase hexadecimal characters from service url-recovery.')
  }
  return value
}

export async function runServiceCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'service' && action === 'list') {
    return requestDaemon(socketPath, 'service.list', { workspace_id: required(rest[0], 'WORKSPACE_ID') })
  }
  if (area === 'service' && action === 'inspect') {
    if (rest.length > 3) throw new CliError('usage', 'service inspect accepts WORKSPACE_ID NAME [TAIL_BYTES].')
    return requestDaemon(socketPath, 'service.inspect', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      tail_bytes: tailBytes(rest[2]),
    })
  }
  if (area === 'service' && action === 'url') {
    if (rest.length !== 3) throw new CliError('usage', 'service url requires WORKSPACE_ID NAME PORT_VARIABLE.')
    return requestDaemon(socketPath, 'service.proxy.ensure', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
    })
  }
  if (area === 'service' && action === 'url-inspect') {
    if (rest.length !== 3) throw new CliError('usage', 'service url-inspect requires WORKSPACE_ID NAME PORT_VARIABLE.')
    return requestDaemon(socketPath, 'service.proxy.inspect', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
    })
  }
  if (area === 'service' && action === 'remap') {
    if (rest.length !== 7) throw new CliError('usage',
      'service remap requires WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_ROUTE_ID EXPECTED_ROUTE_PORT.')
    return requestDaemon(socketPath, 'service.proxy.remap', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
      expected_service_identity: required(rest[3], 'EXPECTED_SERVICE_ID'),
      expected_target_port: port(rest[4], 'EXPECTED_TARGET_PORT'),
      expected_route_identity: required(rest[5], 'EXPECTED_ROUTE_ID'),
      expected_route_port: port(rest[6], 'EXPECTED_ROUTE_PORT'),
    })
  }
  if (area === 'service' && action === 'url-retire') {
    if (rest.length !== 7) throw new CliError('usage',
      'service url-retire requires WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT.')
    return requestDaemon(socketPath, 'service.proxy.retire', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
      expected_route_id: required(rest[3], 'EXPECTED_ROUTE_ID'),
      expected_service_identity: required(rest[4], 'EXPECTED_SERVICE_ID'),
      expected_target_port: port(rest[5], 'EXPECTED_TARGET_PORT'),
      expected_proxy_port: port(rest[6], 'EXPECTED_PROXY_PORT'),
    })
  }
  if (area === 'service' && action === 'url-recovery') {
    if (rest.length) throw new CliError('usage', 'service url-recovery does not accept arguments.')
    return requestDaemon(socketPath, 'service.proxy.recovery.inspect')
  }
  if (area === 'service' && action === 'url-retry') {
    if (rest.length !== 7) throw new CliError('usage',
      'service url-retry requires WORKSPACE_ID NAME PORT_VARIABLE EXPECTED_ROUTE_ID EXPECTED_SERVICE_ID EXPECTED_TARGET_PORT EXPECTED_PROXY_PORT.')
    return requestDaemon(socketPath, 'service.proxy.recovery.retry', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      port_variable: required(rest[2], 'PORT_VARIABLE'),
      expected_route_id: required(rest[3], 'EXPECTED_ROUTE_ID'),
      expected_service_identity: required(rest[4], 'EXPECTED_SERVICE_ID'),
      expected_target_port: port(rest[5], 'EXPECTED_TARGET_PORT'),
      expected_proxy_port: port(rest[6], 'EXPECTED_PROXY_PORT'),
    })
  }
  if (area === 'service' && action === 'url-recovery-reset') {
    if (rest.length !== 2 || rest[1] !== '--confirm-reset') throw new CliError('usage',
      'service url-recovery-reset requires EXPECTED_REGISTRY_SHA256 --confirm-reset. Inspect first; the corrupt bytes are archived.')
    return requestDaemon(socketPath, 'service.proxy.recovery.reset', {
      expected_registry_sha256: sha256(rest[0]),
    })
  }
  if (area === 'service' && action === 'configure') {
    return requestDaemon(socketPath, 'service.configure', {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
      config: jsonObject(rest[2], 'JSON_CONFIG'), revision: revision(rest[3]),
    })
  }
  if (area === 'service' && (action === 'start' || action === 'stop')) {
    return requestDaemon(socketPath, `service.${action}`, {
      workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
    })
  }
  if (area === 'script' && (action === 'list' || action === 'runs')) {
    if (rest.length !== 1) throw new CliError('usage', `script ${action} requires WORKSPACE_ID.`)
    const op = action === 'list' ? 'script.list' : 'script.runs'
    return dailyUseCommand(socketPath, { op, workspace_id: required(rest[0], 'WORKSPACE_ID') })
  }
  if (area === 'script' && action === 'start') {
    if (rest.length !== 2) throw new CliError('usage', 'script start requires WORKSPACE_ID NAME.')
    return dailyUseCommand(socketPath, {
      op: 'script.start', workspace_id: required(rest[0], 'WORKSPACE_ID'), name: required(rest[1], 'NAME'),
    })
  }
  if (area === 'script' && action === 'inspect') {
    if (rest.length < 2 || rest.length > 3) {
      throw new CliError('usage', 'script inspect requires WORKSPACE_ID RUN_ID [TAIL_BYTES].')
    }
    return dailyUseCommand(socketPath, {
      op: 'script.inspect', workspace_id: required(rest[0], 'WORKSPACE_ID'), run_id: required(rest[1], 'RUN_ID'),
      ...(rest[2] === undefined ? {} : { tail_bytes: tailBytes(rest[2]) }),
    })
  }
  if (area === 'script' && (action === 'stop' || action === 'retire')) {
    if (rest.length !== 2) throw new CliError('usage', `script ${action} requires WORKSPACE_ID RUN_ID.`)
    const op = action === 'stop' ? 'script.stop' : 'script.retire'
    return dailyUseCommand(socketPath, {
      op, workspace_id: required(rest[0], 'WORKSPACE_ID'), run_id: required(rest[1], 'RUN_ID'),
    })
  }
  return undefined
}

export async function runListenerCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'listener' && action === 'list') {
    if (rest.length) throw new CliError('usage', 'listener list does not accept arguments.')
    return requestDaemon(socketPath, 'listener.list')
  }
  return undefined
}
