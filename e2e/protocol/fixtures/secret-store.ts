// The test-only secret store every spec process uses in place of the macOS
// Keychain. `scratchEnvironment` sets ADE_SECRET_STORE=file with a store file
// and key inside the scratch HOME, so no spec ever reaches the Keychain,
// `securityd` or the `security` tool. A release daemon refuses this store.
//
// This mirrors the format of `file::FileStore` in
// crates/ade-daemon/src/credentials.rs, so a spec can add, change and inspect
// items as a user would add their own Keychain item. The encryption guards
// test values only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type Item = { service: string; account: string; value: string }
type Envelope = { version: 1; nonce: string; data: string; tag: string }

/** Where a scratch HOME's secret store lives, and its key: fixed per HOME. */
export function secretStoreEnvironment(home: string): Record<string, string> {
  return {
    ADE_SECRET_STORE: 'file',
    ADE_SECRET_FILE: join(home, '.ade-secrets', 'store.json'),
    ADE_SECRET_KEY: createHash('sha256').update(`ade-e2e-secret-key\0${home}`).digest('hex'),
  }
}

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/** A profile's secret store file, read and written in the daemon's format. */
export class ScratchSecretStore {
  readonly path: string
  private readonly encKey: Buffer
  private readonly macKey: Buffer

  constructor(readonly home: string) {
    const env = secretStoreEnvironment(home)
    this.path = env.ADE_SECRET_FILE
    const key = Buffer.from(env.ADE_SECRET_KEY, 'hex')
    this.encKey = sha256(Buffer.from('ade-secret-file enc\0'), key)
    this.macKey = sha256(Buffer.from('ade-secret-file mac\0'), key)
  }

  /** Make the store's directory; without it the daemon reports the store unavailable. */
  async create(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
  }

  private keystream(nonce: Buffer, data: Buffer): Buffer {
    const out = Buffer.from(data)
    for (let offset = 0, block = 0; offset < out.length; offset += 32, block += 1) {
      const counter = Buffer.alloc(8)
      counter.writeBigUInt64BE(BigInt(block))
      const pad = sha256(this.encKey, nonce, counter)
      for (let index = 0; index < 32 && offset + index < out.length; index += 1) out[offset + index] ^= pad[index]
    }
    return out
  }

  private tag(nonce: Buffer, data: Buffer): Buffer {
    return createHmac('sha256', this.macKey).update(nonce).update(data).digest()
  }

  private async load(): Promise<Item[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const envelope = JSON.parse(text) as Envelope
    const nonce = Buffer.from(envelope.nonce, 'hex')
    const data = Buffer.from(envelope.data, 'hex')
    const tag = Buffer.from(envelope.tag, 'hex')
    const expected = this.tag(nonce, data)
    if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) {
      throw new Error(`Secret store ${this.path} failed authentication`)
    }
    return JSON.parse(this.keystream(nonce, data).toString('utf8')) as Item[]
  }

  private async save(items: Item[]): Promise<void> {
    const nonce = randomBytes(32)
    const data = this.keystream(nonce, Buffer.from(JSON.stringify(items)))
    const envelope: Envelope = { version: 1, nonce: nonce.toString('hex'), data: data.toString('hex'),
      tag: this.tag(nonce, data).toString('hex') }
    const temporary = `${this.path}.tmp-${randomBytes(8).toString('hex')}`
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.path)
  }

  /** Add or replace an item, as a user would for a reference. */
  async add(service: string, account: string, value: string): Promise<void> {
    await this.create()
    const items = (await this.load()).filter((item) => !(item.service === service && item.account === account))
    await this.save([...items, { service, account, value }])
  }

  /** The value of an item, or null when it does not exist. */
  async find(service: string, account: string): Promise<string | null> {
    return (await this.load()).find((item) => item.service === service && item.account === account)?.value ?? null
  }

  /** Delete an item; a missing item is not an error. */
  async delete(service: string, account: string): Promise<void> {
    const items = await this.load()
    const kept = items.filter((item) => !(item.service === service && item.account === account))
    if (kept.length !== items.length) await this.save(kept)
  }

  /** The accounts of every item under `service`, sorted. */
  async accounts(service: string): Promise<string[]> {
    return (await this.load()).filter((item) => item.service === service).map((item) => item.account).sort()
  }

  /** The raw bytes of the store file, empty when it does not exist; for at-rest checks. */
  async raw(): Promise<Buffer> {
    return readFile(this.path).catch(() => Buffer.alloc(0))
  }
}
