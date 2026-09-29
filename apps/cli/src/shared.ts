import { randomUUID } from 'node:crypto'
import { requestDaemon, type DaemonResponse } from '@ade/client'
import { lockJournalDirectory, openClientJournals, type ClientJournals } from '@ade/client/journals'

export type CommandResult = DaemonResponse | Record<string, unknown>

export type ErrorCode =
  | 'usage'
  | 'unavailable'
  | 'incompatible'
  | 'timeout'
  | 'protocol'
  | 'daemon'
  | 'invalid_request'
  | 'conflict'
  | 'outcome_unknown'
  | 'in_progress'
  | 'overloaded'
  | 'not_applied'

export class CliError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

let chosenOperationId: string | undefined
let sentOperationId: string | undefined

/** Selects the operation ID from the global `--operation-id` option, given once. */
export function chooseOperationId(id: string): void {
  if (chosenOperationId !== undefined) throw new CliError('usage', '--operation-id may be supplied only once.')
  if (!id || id.startsWith('--') || Buffer.byteLength(id) > 256) {
    throw new CliError('usage', '--operation-id requires an ID of 1 to 256 bytes.')
  }
  chosenOperationId = id
}

/**
 * The operation ID of this invocation's effect command: `--operation-id`, or a
 * fresh one. Errors report it, so a lost reply can be retried under it.
 */
export function effectOperationId(): string {
  sentOperationId ??= chosenOperationId ?? randomUUID()
  return sentOperationId
}

/**
 * The operation ID the caller chose with `--operation-id`, for a command whose
 * caller must retain it to inspect or retry the operation: a Git or worktree
 * mutation, for one. A generated ID could not be recovered after a lost reply.
 */
export function requiredOperationId(): string {
  if (chosenOperationId === undefined) {
    throw new CliError(
      'usage',
      'This command requires --operation-id ID (1 to 256 bytes); reuse it only to retry the same request.',
    )
  }
  return effectOperationId()
}

/** The operation ID this invocation sent, if it sent one. */
export function usedOperationId(): string | undefined {
  return sentOperationId
}

/** The profile this invocation acts for, as its client journals name it, and where they live. */
type JournalOwner = { profileId: string; directory: string }
let journalOwner: (() => JournalOwner) | undefined

/** Names where this invocation's journals live; resolved only when a command uses them. */
export function selectJournalOwner(owner: () => JournalOwner): void {
  journalOwner = owner
}

/**
 * Runs `work` with this profile's client journals, which hold prompts and Git
 * mutations the daemon has not admitted. The journal directory is held for this
 * process alone until `work` ends, so concurrent commands never overwrite each
 * other's records.
 */
export async function withJournals<T>(work: (journals: ClientJournals, profileId: string) => Promise<T>): Promise<T> {
  if (!journalOwner) throw new CliError('protocol', 'Client journals are unavailable for this command.')
  const { profileId, directory } = journalOwner()
  let release: () => Promise<void>
  let journals: ClientJournals
  try {
    release = await lockJournalDirectory(directory)
  } catch (error) {
    throw new CliError('in_progress', String(error instanceof Error ? error.message : error))
  }
  try {
    try {
      journals = await openClientJournals(directory)
    } catch (error) {
      throw new CliError('protocol', `Client journals at ${directory} are unreadable: ${String(error)}`)
    }
    return await work(journals, profileId)
  } finally {
    await release()
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
  try {
    parsed = JSON.parse(required(value, label))
  } catch {
    throw new CliError('usage', `${label} must be valid JSON.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new CliError('usage', `${label} must be an object.`)
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

export function parseWords(
  words: string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
  command: string,
): ParsedWords {
  const parsed: ParsedWords = { positionals: [], options: {}, flags: new Set() }
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (!word.startsWith('--')) {
      parsed.positionals.push(word)
      continue
    }
    if (flagOptions.includes(word) && !parsed.flags.has(word)) {
      parsed.flags.add(word)
      continue
    }
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

/**
 * A caller-owned request ID for an operation whose own field is `request_id`
 * (a prompt, a queued prompt, an attachment), retained by the caller and
 * reused only to retry the same request.
 */
export function requestIdOption(parsed: ParsedWords, command: string): string {
  const id = parsed.options['--request-id']
  if (!id || Buffer.byteLength(id) > 256) {
    throw new CliError(
      'usage',
      `${command} requires --request-id ID (1 to 256 bytes); reuse it only to retry the same request.`,
    )
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
