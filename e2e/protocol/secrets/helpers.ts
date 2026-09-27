// Helpers for the secret-reference specs: where a profile keeps its data,
// whether any byte of it carries a secret, and what an ADE-owned reference
// looks like. Every profile keeps secrets in the test-only file store
// (fixtures/secret-store.ts); no spec reaches the Keychain.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type ScratchProfile } from '../fixtures'

/** The service name of every item ADE creates. */
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

/** The ID that prefixes the account of every item the profile makes; its data directory holds it. */
export async function ownerId(profile: ScratchProfile): Promise<string> {
  return (await readFile(join(profile.dataDirectory, 'secret-owner'), 'utf8')).trim()
}

/** A matcher for a reference to an item `profile` made under `scope`. */
export async function ownedReference(profile: ScratchProfile, scope: string): Promise<unknown> {
  const escaped = `${await ownerId(profile)}/${scope}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { keychain: { service: ADE_KEYCHAIN_SERVICE, account: expect.stringMatching(new RegExp(`^${escaped}/[0-9a-f]{32}$`)) } }
}

/** Whether the secret store file holds `secret` in plain text; it must not, since it is encrypted at rest. */
export async function storeHoldsPlainly(profile: ScratchProfile, secret: string): Promise<boolean> {
  return (await profile.secrets.raw()).includes(secret)
}

export type KeychainReference = { keychain: { service: string; account: string } }
