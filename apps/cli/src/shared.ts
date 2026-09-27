import { requestDaemon, type DaemonResponse } from '@ade/client'

export type CommandResult = DaemonResponse | Record<string, unknown>

export type ErrorCode = 'usage' | 'unavailable' | 'incompatible' | 'timeout' | 'protocol' | 'daemon' |
  'invalid_request' | 'conflict' | 'outcome_unknown' | 'in_progress' | 'overloaded'

export class CliError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message)
  }
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new CliError('usage', `${label} is required.`)
  return value
}

export function namedOptions(words: string[], allowed: readonly string[], command: string): Record<string, string> {
  const options: Record<string, string> = {}
  for (let index = 0; index < words.length; index += 2) {
    const key = words[index]
    const value = words[index + 1]
    if (!allowed.includes(key) || !value || value.startsWith('--') || options[key] !== undefined) {
      throw new CliError('usage', `Invalid ${command} option. Run ade --help for usage.`)
    }
    options[key] = value
  }
  return options
}

export function jsonObject(value: string | undefined, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(required(value, label)) }
  catch { throw new CliError('usage', `${label} must be valid JSON.`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('usage', `${label} must be an object.`)
  return parsed as Record<string, unknown>
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('protocol', 'Daemon returned an invalid object.')
  }
  return value as Record<string, unknown>
}

export async function catalog(socketPath: string): Promise<Record<string, unknown>> {
  const result = await requestDaemon(socketPath, 'catalog.get')
  return object(result.catalog)
}
