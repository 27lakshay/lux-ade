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
  device input HOST DEVICE --request-id ID (--tap X,Y | --swipe X1,Y1,X2,Y2 [--duration-ms N]
                        | --text TEXT | --key home|back|enter|delete|tab|escape) [--agent CONVERSATION]
                                        Send one input event to one exact booted device, attributed
                                        to the user or to the Agent of CONVERSATION
`

const families = ['computer', 'ios_simulator', 'android'] as const
const keys = ['home', 'back', 'enter', 'delete', 'tab', 'escape'] as const
type Key = typeof keys[number]
type InputAction = DailyUseRequest<'device.input'>['action']

function numbers(value: string, count: number, flag: string): number[] {
  const parts = value.split(',')
  if (parts.length !== count || !parts.every((part) => /^\d{1,6}$/.test(part))) {
    throw new CliError('usage', `${flag} takes ${count} comma-separated whole numbers.`)
  }
  return parts.map(Number)
}

function inputAction(options: Record<string, string>): InputAction {
  const given = ['--tap', '--swipe', '--text', '--key'].filter((flag) => options[flag] !== undefined)
  if (given.length !== 1) throw new CliError('usage', 'device input takes exactly one of --tap, --swipe, --text or --key.')
  if (options['--duration-ms'] !== undefined && given[0] !== '--swipe') {
    throw new CliError('usage', '--duration-ms applies only to --swipe.')
  }
  switch (given[0]) {
    case '--tap': {
      const [x, y] = numbers(options['--tap'], 2, '--tap')
      return { kind: 'tap', x, y }
    }
    case '--swipe': {
      const [fromX, fromY, toX, toY] = numbers(options['--swipe'], 4, '--swipe')
      const duration = options['--duration-ms']
      return { kind: 'swipe', from_x: fromX, from_y: fromY, to_x: toX, to_y: toY,
        ...(duration === undefined ? {} : { duration_ms: numbers(duration, 1, '--duration-ms')[0] }) }
    }
    case '--text': return { kind: 'text', text: options['--text'] }
    default: {
      const key = options['--key']
      if (!keys.includes(key as Key)) throw new CliError('usage', `--key takes ${keys.join(', ')}.`)
      return { kind: 'key', key: key as Key }
    }
  }
}
type Family = typeof families[number]

// Daemon deadlines plus room for the reply; a boot waits up to its own timeout.
const TIMEOUTS = { list: 60_000, screenshot: 60_000, install: 330_000, launch: 120_000, input: 90_000 }

async function call<O extends DailyUseOperation>(socketPath: string, request: DailyUseRequest<O>,
  timeoutMs: number): Promise<Record<string, unknown>> {
  decodeDailyUseRequest(request)
  const { op, ...fields } = request
  const response = await requestDaemon(socketPath, op, fields, { timeoutMs })
  try { return decodeDailyUseResponse(op, response) }
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
  if (action === 'input') {
    const { args, options } = split(rest, 2,
      ['--request-id', '--tap', '--swipe', '--duration-ms', '--text', '--key', '--agent'], 'input')
    const agent = options['--agent']
    return call(socketPath, { op: 'device.input', operation_id: required(options['--request-id'], '--request-id'),
      host_id: required(args[0], 'HOST'), device_id: required(args[1], 'DEVICE'),
      caller: agent === undefined ? { kind: 'user' } : { kind: 'agent', conversation_id: agent },
      action: inputAction(options) }, TIMEOUTS.input)
  }
  return undefined
}
