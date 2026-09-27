import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { decodeDailyUseRequest, decodeDailyUseResponse, requestDaemon, type DailyUseOperation,
  type DailyUseRequest } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const deviceUsage = `  device list [--family computer|ios_simulator|android]
                                        List host devices, their capabilities and why any are unavailable
  device screenshot HOST DEVICE --out FILE
                                        Save a PNG of one exact device or display; FILE must not exist
  device boot HOST DEVICE --request-id ID [--timeout-ms N]
                                        Boot one simulator or AVD and wait until it is usable
  device install HOST DEVICE APP_PATH --request-id ID
                                        Install a .app (simulator) or .apk (Android) and confirm its version
  device launch HOST DEVICE APP_ID --request-id ID
                                        Launch an installed app and report its process ID
`

const families = ['computer', 'ios_simulator', 'android'] as const
type Family = typeof families[number]

// Daemon deadlines plus room for the reply; a boot waits up to its own timeout.
const TIMEOUTS = { list: 60_000, screenshot: 60_000, install: 330_000, launch: 120_000 }

async function call<O extends DailyUseOperation>(socketPath: string, request: DailyUseRequest<O>,
  timeoutMs: number): Promise<Record<string, unknown>> {
  decodeDailyUseRequest(request)
  const { op, ...fields } = request
  const response = await requestDaemon(socketPath, op, fields, { timeoutMs })
  try { return decodeDailyUseResponse(op, response) as unknown as Record<string, unknown> }
  catch (error) { throw new CliError('protocol', `Daemon ${op} reply failed its contract: ${String(error)}`) }
}

function split(rest: string[], positional: number, allowed: readonly string[], command: string):
  { args: string[]; options: Record<string, string> } {
  if (rest.length < positional || rest.slice(0, positional).some((word) => word.startsWith('--'))) {
    throw new CliError('usage', `device ${command} is missing arguments. Run ade --help for usage.`)
  }
  return { args: rest.slice(0, positional), options: namedOptions(rest.slice(positional), allowed, `device ${command}`) }
}

/** Device commands. Each names its host and device; none follows focus or picks a default. */
export async function runDeviceCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'device') return undefined
  if (action === 'list') {
    const { options } = split(rest, 0, ['--family'], 'list')
    const family = options['--family']
    if (family !== undefined && !families.includes(family as Family)) {
      throw new CliError('usage', `--family takes ${families.join(', ')}.`)
    }
    return call(socketPath, { op: 'device.list', ...(family ? { family: family as Family } : {}) }, TIMEOUTS.list)
  }
  if (action === 'screenshot') {
    const { args, options } = split(rest, 2, ['--out'], 'screenshot')
    const out = resolve(required(options['--out'], '--out'))
    const reply = await call(socketPath, { op: 'device.screenshot', host_id: required(args[0], 'HOST'),
      device_id: required(args[1], 'DEVICE') }, TIMEOUTS.screenshot)
    const { bytes_base64: encoded, ...summary } = reply
    // `wx` refuses to replace an existing file.
    await writeFile(out, Buffer.from(String(encoded), 'base64'), { flag: 'wx', mode: 0o600 })
    return { ...summary, path: out }
  }
  if (action === 'boot') {
    const { args, options } = split(rest, 2, ['--request-id', '--timeout-ms'], 'boot')
    const raw = options['--timeout-ms']
    if (raw !== undefined && !/^\d{1,7}$/.test(raw)) throw new CliError('usage', '--timeout-ms must be a whole number.')
    const timeout = raw === undefined ? undefined : Number(raw)
    return call(socketPath, { op: 'device.boot', operation_id: required(options['--request-id'], '--request-id'),
      host_id: required(args[0], 'HOST'), device_id: required(args[1], 'DEVICE'),
      ...(timeout === undefined ? {} : { timeout_ms: timeout }) }, (timeout ?? 120_000) + 60_000)
  }
  if (action === 'install') {
    const { args, options } = split(rest, 3, ['--request-id'], 'install')
    return call(socketPath, { op: 'device.app.install', operation_id: required(options['--request-id'], '--request-id'),
      host_id: required(args[0], 'HOST'), device_id: required(args[1], 'DEVICE'),
      app_path: resolve(required(args[2], 'APP_PATH')) }, TIMEOUTS.install)
  }
  if (action === 'launch') {
    const { args, options } = split(rest, 3, ['--request-id'], 'launch')
    return call(socketPath, { op: 'device.app.launch', operation_id: required(options['--request-id'], '--request-id'),
      host_id: required(args[0], 'HOST'), device_id: required(args[1], 'DEVICE'),
      app_id: required(args[2], 'APP_ID') }, TIMEOUTS.launch)
  }
  return undefined
}
