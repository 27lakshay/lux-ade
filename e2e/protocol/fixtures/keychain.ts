// A scratch macOS keychain for each profile. `security create-keychain` makes
// it inside the profile's scratch HOME, and the daemon is confined to it with
// ADE_KEYCHAIN, so no spec ever reads or writes the user's login keychain or
// changes their keychain search list. Every `security` call here runs with the
// scratch HOME and names the scratch keychain file explicitly.
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { scratchEnvironment } from './environment'

/** The password of every scratch keychain; it guards nothing real. */
const PASSWORD = 'ade-e2e'

/** Where a profile's scratch keychain lives, inside its scratch HOME. */
export function scratchKeychainPath(home: string): string {
  return join(home, 'Library', 'Keychains', 'ade-e2e.keychain-db')
}

type SecurityResult = { code: number; stdout: string; stderr: string }

function security(home: string, args: string[]): Promise<SecurityResult> {
  return new Promise((resolveRun) => {
    execFile('/usr/bin/security', args, { env: scratchEnvironment(home), encoding: 'utf8', timeout: 15_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolveRun({ code, stdout, stderr })
      })
  })
}

async function required(home: string, args: string[]): Promise<string> {
  const result = await security(home, args)
  if (result.code !== 0) throw new Error(`security ${args[0]} failed (${result.code}): ${result.stderr.trim()}`)
  return result.stdout
}

/** The code directory hash of an ad-hoc signed program; null for a platform binary. */
function codeDirectoryHash(home: string, program: string): Promise<string | null> {
  if (program.startsWith('/usr/') || program.startsWith('/System/')) return Promise.resolve(null)
  return new Promise((resolveHash) => {
    execFile('/usr/bin/codesign', ['-dvvv', program], { env: scratchEnvironment(home), encoding: 'utf8' },
      (_error, stdout, stderr) => resolveHash(/^CDHash=([0-9a-f]+)$/m.exec(`${stdout}\n${stderr}`)?.[1] ?? null))
  })
}

/** A keychain the scratch HOME owns; refuses any path outside it. */
export class ScratchKeychain {
  constructor(readonly home: string, readonly path = scratchKeychainPath(home)) {
    const inside = relative(home, path)
    if (inside.startsWith('..') || inside === path) throw new Error(`Keychain ${path} is outside the scratch HOME ${home}`)
  }

  /** Create and unlock the keychain with no auto-lock timeout. */
  async create(): Promise<void> {
    await mkdir(join(this.home, 'Library', 'Keychains'), { recursive: true, mode: 0o700 })
    await required(this.home, ['create-keychain', '-p', PASSWORD, this.path])
    await required(this.home, ['unlock-keychain', '-p', PASSWORD, this.path])
    await required(this.home, ['set-keychain-settings', this.path])
  }

  /**
   * Add or replace a generic password, as a user would for a reference, and
   * trust `readers` (absolute program paths, such as the built ade-daemon)
   * to read it without a prompt.
   */
  async add(service: string, account: string, value: string, readers: string[] = []): Promise<void> {
    // Replace by deleting first: an update in place would need the ACL to
    // admit `security` for writing, which a narrowed item may not.
    await this.delete(service, account)
    await required(this.home, ['add-generic-password', '-s', service, '-a', account, '-w', value,
      ...readers.flatMap((reader) => ['-T', reader]), this.path])
    if (!readers.length) return
    // The ACL is not enough: an item's partition list must also name each
    // reader's signature. A locally built binary is ad-hoc signed, so it is
    // named by its code directory hash.
    const partitions = ['apple-tool:', 'apple:']
    for (const reader of readers) {
      const hash = await codeDirectoryHash(this.home, reader)
      if (hash) partitions.push(`cdhash:${hash}`)
    }
    await required(this.home, ['set-generic-password-partition-list', '-S', partitions.join(','),
      '-s', service, '-a', account, '-k', PASSWORD, this.path])
  }

  /**
   * The password of an item `security` itself added, or null when it does
   * not exist. ASCII values only. An item the daemon created is readable
   * only by the daemon; check those with `accounts` instead.
   */
  async find(service: string, account: string): Promise<string | null> {
    const result = await security(this.home, ['find-generic-password', '-s', service, '-a', account, '-w', this.path])
    if (result.code === 44) return null
    if (result.code !== 0) throw new Error(`security find-generic-password failed (${result.code}): ${result.stderr.trim()}`)
    return result.stdout.replace(/\n$/, '')
  }

  /** Delete an item; a missing item is not an error. */
  async delete(service: string, account: string): Promise<void> {
    const result = await security(this.home, ['delete-generic-password', '-s', service, '-a', account, this.path])
    if (result.code !== 0 && result.code !== 44) {
      throw new Error(`security delete-generic-password failed (${result.code}): ${result.stderr.trim()}`)
    }
  }

  /** The accounts of every generic password under `service`, sorted. Reads attributes, never values. */
  async accounts(service: string): Promise<string[]> {
    const dump = await required(this.home, ['dump-keychain', this.path])
    const accounts: string[] = []
    for (const item of dump.split(/^keychain: /m).slice(1)) {
      if (!/^class: "genp"/m.test(item)) continue
      const svce = /"svce"<blob>="((?:[^"\\]|\\.)*)"/.exec(item)?.[1]
      const acct = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(item)?.[1]
      if (svce === service && acct !== undefined) accounts.push(acct)
    }
    return accounts.sort()
  }
}
