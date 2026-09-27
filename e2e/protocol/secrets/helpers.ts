// Helpers for the secret-reference specs: where a profile keeps its data,
// whether any byte of it carries a secret, and what an ADE-owned reference
// looks like.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type ScratchProfile } from '../fixtures'

/** The service name of every Keychain item ADE creates. */
export const ADE_KEYCHAIN_SERVICE = 'ADE secret'
export const REDACTED = '[redacted]'

/** Every file below the profile's data directory whose bytes contain `secret`. */
export async function filesHolding(profile: ScratchProfile, secret: string): Promise<string[]> {
  const entries = await readdir(profile.dataDirectory, { recursive: true, withFileTypes: true })
  const holding: string[] = []
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const path = join(entry.parentPath, entry.name)
    const bytes = await readFile(path).catch(() => null)
    if (bytes?.includes(secret)) holding.push(path)
  }
  return holding
}

export function sessionsDatabase(profile: ScratchProfile): string {
  return join(profile.dataDirectory, 'sessions.sqlite')
}

export function pluginsDatabase(profile: ScratchProfile): string {
  return join(profile.dataDirectory, 'sessions.plugins.sqlite3')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A matcher for a reference to a Keychain item ADE made under `scope`. */
export function ownedReference(scope: string): unknown {
  const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { keychain: { service: ADE_KEYCHAIN_SERVICE, account: expect.stringMatching(new RegExp(`^${escaped}/[0-9a-f]{32}$`)) } }
}

export type KeychainReference = { keychain: { service: string; account: string } }
