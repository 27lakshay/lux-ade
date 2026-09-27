// R001 and R002 for the five browser effect commands. The daemon relays each
// to the registered browser owner (Electron in the product); a scripted owner
// on a private socket stands in for it here and records every command, so a
// second execution would show up as a second relayed command.
//
// - R002: the same operation ID and payload returns the recorded reply without
//   reaching the owner again; another payload is a strict conflict. Both hold
//   after a daemon SIGKILL, before any owner has registered again.
// - R001: the daemon is SIGKILLed while the owner holds the dispatched command.
//   The retry reports an explicit unknown and never relays it again; the owner
//   then proves the outcome through browser.operation, which settles it.
import { chmod, mkdir } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { fixedBrowserProfile } from '../fixtures/browser-owner'

type Command = Record<string, unknown> & { op: string; request_id?: string }

/** A browser owner that answers each mutation as done, or holds it unanswered while `holding`. */
class Owner {
  readonly commands: Command[] = []
  holding = false
  private readonly held: Socket[] = []
  private server: Server | null = null
  readonly profileId: string
  readonly ownerId = 'core-owner'

  constructor(private readonly profile: ScratchProfile) {
    this.profileId = fixedBrowserProfile(profile.socket)
  }

  static async start(profile: ScratchProfile): Promise<Owner> {
    const owner = new Owner(profile)
    const directory = join(profile.root, 'bo')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const socket = join(directory, 'o.sock')
    owner.server = createServer((peer) => owner.serve(peer))
    await new Promise<void>((resolveListen) => owner.server!.listen(socket, () => resolveListen()))
    owner.server.unref()
    await chmod(socket, 0o600)
    await owner.register()
    return owner
  }

  /** Register with the running daemon; a new daemon forgets the owner. */
  async register(): Promise<void> {
    const socket = join(this.profile.root, 'bo', 'o.sock')
    const registered = await this.profile.rpc({
      op: 'browser.owner.register',
      profile_id: this.profileId,
      owner_id: this.ownerId,
      socket_path: socket,
    })
    expect(registered.type, JSON.stringify(registered)).not.toBe('error')
  }

  relayed(op: string, requestId: string): number {
    return this.commands.filter((command) => command.op === op && command.request_id === requestId).length
  }

  close(): void {
    for (const peer of this.held) peer.destroy()
    this.server?.close()
  }

  private serve(peer: Socket): void {
    let buffered = ''
    peer.on('error', () => undefined)
    peer.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const end = buffered.indexOf('\n')
      if (end < 0) return
      const command = JSON.parse(buffered.slice(0, end)) as Command
      this.commands.push(command)
      if (command.op === 'browser.operation') {
        // The owner proves an interrupted mutation from its tabs.
        const done = this.commands.find(
          (earlier) => earlier.request_id === command.request_id && earlier.op !== command.op,
        )
        peer.end(
          `${JSON.stringify({
            type: 'browser_operation',
            profile_id: this.profileId,
            owner_id: this.ownerId,
            request_id: command.request_id,
            payload_fingerprint: done?.payload_fingerprint,
            state: 'completed',
            result: done && this.mutation(done),
          })}\n`,
        )
      } else if (this.holding) {
        this.held.push(peer)
      } else {
        peer.end(`${JSON.stringify(this.mutation(command))}\n`)
      }
    })
  }

  private mutation(command: Command): Record<string, unknown> {
    return {
      type: 'browser_mutation',
      profile_id: command.profile_id,
      owner_id: command.owner_id,
      request_id: command.request_id,
      payload_fingerprint: command.payload_fingerprint,
      op: command.op,
      tab_id: command.tab_id ?? 'tab-opened',
    }
  }
}

type Case = { op: string; request: (owner: Owner, altered: boolean) => Record<string, unknown> }

const target = (owner: Owner) => ({ profile_id: owner.profileId, owner_id: owner.ownerId })
const cases: Case[] = [
  {
    op: 'browser.open',
    request: (owner, altered) => ({
      ...target(owner),
      url: altered ? 'https://other.example/' : 'https://core.example/',
    }),
  },
  {
    op: 'browser.navigate',
    request: (owner, altered) => ({
      ...target(owner),
      tab_id: 'tab-1',
      url: altered ? 'https://other.example/' : 'https://core.example/next',
    }),
  },
  { op: 'browser.close', request: (owner, altered) => ({ ...target(owner), tab_id: altered ? 'tab-2' : 'tab-1' }) },
  {
    op: 'browser.click',
    request: (owner, altered) => ({ ...target(owner), tab_id: 'tab-1', selector: altered ? '#other' : '#go' }),
  },
  {
    op: 'browser.type',
    request: (owner, altered) => ({
      ...target(owner),
      tab_id: 'tab-1',
      selector: 'input',
      text: altered ? 'other text' : 'core text',
    }),
  },
]

async function attempt(profile: ScratchProfile, op: string, request: Record<string, unknown>) {
  try {
    return { reply: await profile.call(op as never, request as never) }
  } catch (error) {
    const failure = error as { code: string; message: string }
    return { error: { code: failure.code, message: failure.message } }
  }
}

for (const effect of cases) {
  test.describe(effect.op, () => {
    test(`R002: ${effect.op} replays one operation ID without reaching the owner again, also after a daemon crash`, async ({
      profile,
    }) => {
      const owner = await Owner.start(profile)
      try {
        const request = { ...effect.request(owner, false), operation_id: 'core-browser' }
        const first = await attempt(profile, effect.op, request)
        expect(first, JSON.stringify(first)).toMatchObject({ reply: { type: 'browser_mutation', op: effect.op } })
        expect(await attempt(profile, effect.op, request)).toEqual(first)
        const altered = { ...effect.request(owner, true), operation_id: 'core-browser' }
        expect(await attempt(profile, effect.op, altered)).toMatchObject({ error: { code: 'conflict' } })
        expect(owner.relayed(effect.op, 'core-browser')).toBe(1)

        // A new daemon, with no owner registered yet, still answers from the receipt.
        await profile.restartDaemon('kill')
        expect(await attempt(profile, effect.op, request)).toEqual(first)
        expect(await attempt(profile, effect.op, altered)).toMatchObject({ error: { code: 'conflict' } })
        await owner.register()
        expect(await attempt(profile, effect.op, request)).toEqual(first)
        expect(owner.relayed(effect.op, 'core-browser')).toBe(1)
      } finally {
        owner.close()
      }
    })

    test(`R001: ${effect.op} held by the owner when the daemon crashes is unknown, never relayed again, and reconciled`, async ({
      profile,
    }) => {
      const owner = await Owner.start(profile)
      try {
        owner.holding = true
        const request = { ...effect.request(owner, false), operation_id: 'core-held' }
        const lost = attempt(profile, effect.op, request)
        await expect.poll(() => owner.relayed(effect.op, 'core-held')).toBe(1)
        await profile.killDaemon()
        expect(await lost).toHaveProperty('error')
        owner.holding = false
        await profile.restartDaemon()
        await owner.register()

        const outcome = await attempt(profile, effect.op, request)
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ error: { code: 'outcome_unknown' } })
        expect(await attempt(profile, effect.op, request)).toEqual(outcome)
        expect(owner.relayed(effect.op, 'core-held')).toBe(1)

        // Reconciliation: the owner proves the outcome, and the receipt settles with it.
        const operation = await profile.call('browser.operation', { operation_id: 'core-held' })
        expect(operation).toMatchObject({ state: 'completed', result: { type: 'browser_mutation', op: effect.op } })
        expect(await attempt(profile, effect.op, request)).toEqual({ reply: operation.result })
        expect(owner.relayed(effect.op, 'core-held')).toBe(1)
      } finally {
        owner.close()
      }
    })
  })
}
