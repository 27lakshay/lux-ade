// R002 across backup and restore. Two receipt stores live outside the profile
// database: `sessions.envelope.sqlite3` (receipts of enveloped effect
// commands such as account.create) and `browser-operations.sqlite3` (browser
// mutation receipts). Format 7 backs up both. Without them, a retry of an
// operation ID recorded only there would run as new work after a restore.
//
// The profile is backed up live, loses its data directory, and is restored in
// place, so the restored daemon serves the same browser profile ID. Each
// retry must replay its recorded reply without acting again, and another
// payload under the same ID must conflict.
import { chmod, mkdir, rename } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { fixedBrowserProfile } from '../fixtures/browser-owner'
import { control } from '../fixtures/control'
import { createBackup, readManifest } from '../backup/helpers'

const ENVELOPE = 'sessions.envelope.sqlite3'
const BROWSER = 'browser-operations.sqlite3'

type Command = Record<string, unknown> & { op: string; request_id?: string }

/** A browser owner on a private socket that answers each mutation as done and records it. */
class Owner {
  readonly commands: Command[] = []
  readonly ownerId = 'storage-owner'
  readonly profileId: string
  private server: Server | null = null

  private constructor(private readonly profile: ScratchProfile) {
    this.profileId = fixedBrowserProfile(profile.socket)
  }

  static async start(profile: ScratchProfile): Promise<Owner> {
    const owner = new Owner(profile)
    const directory = join(profile.root, 'bo')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const socket = join(directory, 'o.sock')
    owner.server = createServer((peer) => {
      let buffered = ''
      peer.on('error', () => undefined)
      peer.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        const end = buffered.indexOf('\n')
        if (end < 0) return
        const command = JSON.parse(buffered.slice(0, end)) as Command
        owner.commands.push(command)
        peer.end(
          `${JSON.stringify({
            type: 'browser_mutation',
            profile_id: command.profile_id,
            owner_id: command.owner_id,
            request_id: command.request_id,
            payload_fingerprint: command.payload_fingerprint,
            op: command.op,
            tab_id: 'tab-opened',
          })}\n`,
        )
      })
    })
    await new Promise<void>((listening) => owner.server!.listen(socket, () => listening()))
    owner.server.unref()
    await chmod(socket, 0o600)
    await owner.register()
    return owner
  }

  /** Register with the running daemon; a new daemon forgets the owner. */
  async register(): Promise<void> {
    const registered = await this.profile.rpc({
      op: 'browser.owner.register',
      profile_id: this.profileId,
      owner_id: this.ownerId,
      socket_path: join(this.profile.root, 'bo', 'o.sock'),
    })
    expect(registered.type, JSON.stringify(registered)).not.toBe('error')
  }

  relayed(requestId: string): number {
    return this.commands.filter((command) => command.request_id === requestId).length
  }

  close(): void {
    this.server?.close()
  }
}

async function attempt(profile: ScratchProfile, op: string, request: Record<string, unknown>) {
  try {
    return { reply: await profile.call(op as never, request as never) }
  } catch (error) {
    const failure = error as { code: string; message: string }
    return { error: { code: failure.code, message: failure.message } }
  }
}

test('a restored profile replays envelope and browser receipts instead of running a retried operation ID again @fault', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const owner = await Owner.start(profile)
  try {
    const open = {
      profile_id: owner.profileId,
      owner_id: owner.ownerId,
      url: 'https://storage.example/',
      operation_id: 'restore-browser-open',
    }
    const opened = await attempt(profile, 'browser.open', open)
    expect(opened, JSON.stringify(opened)).toMatchObject({ reply: { type: 'browser_mutation', op: 'browser.open' } })
    const account = { operation_id: 'restore-account-create', provider: 'codex', name: 'Receipt account' }
    const created = await attempt(profile, 'account.create', account)
    expect(created, JSON.stringify(created)).toHaveProperty('reply')
    const accountsBefore = (await profile.call('account.list', {})).accounts.map((item) => item.id)

    // A live backup holds both receipt stores and says so.
    const { path: bundle, result } = await createBackup(ade, profile)
    expect(result.code, result.stderr).toBe(0)
    const manifest = await readManifest(bundle)
    expect(manifest.format_version).toBe(7)
    expect(manifest.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([ENVELOPE, BROWSER]))
    expect(manifest.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: ENVELOPE, disposition: 'backed_up' }),
        expect.objectContaining({ store: BROWSER, disposition: 'backed_up' }),
      ]),
    )

    // The profile loses its data and is restored in place from the bundle.
    await profile.stop()
    await rename(profile.dataDirectory, `${profile.dataDirectory}-lost`)
    const restored = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', profile.dataDirectory])
    expect(restored.code, restored.stderr).toBe(0)
    await profile.restartDaemon()
    await owner.register()

    // The browser retry replays the recorded reply and never reaches the owner again.
    expect(await attempt(profile, 'browser.open', open)).toEqual(opened)
    expect(await attempt(profile, 'browser.open', { ...open, url: 'https://other.example/' })).toMatchObject({
      error: { code: 'conflict' },
    })
    expect(owner.relayed('restore-browser-open')).toBe(1)

    // The account retry replays too; no second account appears.
    expect(await attempt(profile, 'account.create', account)).toEqual(created)
    expect(await attempt(profile, 'account.create', { ...account, name: 'Another account' })).toMatchObject({
      error: { code: 'conflict' },
    })
    expect((await profile.call('account.list', {})).accounts.map((item) => item.id)).toEqual(accountsBefore)
  } finally {
    owner.close()
  }
})
