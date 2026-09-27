import { requestDaemon, type DaemonResponse } from '@ade/client'

export type CommandResult = DaemonResponse | Record<string, unknown>

export type ErrorCode = 'usage' | 'unavailable' | 'incompatible' | 'timeout' | 'protocol' | 'daemon' |
  'invalid_request' | 'conflict' | 'outcome_unknown' | 'in_progress' | 'overloaded' | 'not_applied'

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

/** Words split into positionals, `--name VALUE` options and bare `--flag`s; anything else is a usage error. */
export interface ParsedWords {
  positionals: string[]
  options: Record<string, string>
  flags: Set<string>
}

export function parseWords(words: string[], valueOptions: readonly string[], flagOptions: readonly string[],
  command: string): ParsedWords {
  const parsed: ParsedWords = { positionals: [], options: {}, flags: new Set() }
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (!word.startsWith('--')) { parsed.positionals.push(word); continue }
    if (flagOptions.includes(word) && !parsed.flags.has(word)) { parsed.flags.add(word); continue }
    const value = words[index + 1]
    if (!valueOptions.includes(word) || parsed.options[word] !== undefined || !value || value.startsWith('--')) {
      throw new CliError('usage', `Invalid ${command} option ${word}. Run ade --help for usage.`)
    }
    parsed.options[word] = value
    index++
  }
  return parsed
}

/** Exactly `count` non-empty positionals, or a usage error naming the expected shape. */
export function positionals(parsed: ParsedWords, count: number, usage: string): string[] {
  if (parsed.positionals.length !== count || parsed.positionals.some((word) => !word)) {
    throw new CliError('usage', `${usage}.`)
  }
  return parsed.positionals
}

/** A caller-owned request ID, retained by the caller and reused only to retry the same request. */
export function requestIdOption(parsed: ParsedWords, command: string): string {
  const id = parsed.options['--request-id']
  if (!id || id.length > 256) {
    throw new CliError('usage', `${command} requires --request-id ID (1 to 256 characters); reuse it only to retry the same request.`)
  }
  return id
}

export function boundedInteger(value: string, label: string, min: number, max: number): number {
  const number = Number(value)
  if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new CliError('usage', `${label} must be an integer from ${min} to ${max}.`)
  }
  return number
}

export async function catalog(socketPath: string): Promise<Record<string, unknown>> {
  const result = await requestDaemon(socketPath, 'catalog.get')
  return object(result.catalog)
}
