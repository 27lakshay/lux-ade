// A headless application view: the SDK's AdeClient feed plus one
// conversation projection from `@ade/client/sync`, the same pair the renderer
// uses. Snapshots come from `conversation.get` on a real daemon. A spec can
// hold a snapshot reply back to make it late, detach the feed to model a lost
// connection and attach a new client, or dispose the view to switch context.
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { expect } from '@playwright/test'
import type { AdeClient, ClientState } from '../../../packages/client/dist/index.js'
import type { ConversationSnapshot, ProjectionCause, ProjectionState, SyncFrame } from '../../../packages/client/dist/sync.js'
import { binaries } from './environment'
import type { ScratchProfile } from './profile'

type ClientModule = typeof import('../../../packages/client/dist/index.js')
type SyncModule = typeof import('../../../packages/client/dist/sync.js')

export type ViewMessage = { id: string; sequence: number; text?: string; [key: string]: unknown }
export type ViewSnapshot = ConversationSnapshot<{ id: string; status: string; [key: string]: unknown }, ViewMessage, unknown>

/** The SDK modules, loaded as ES modules. */
export async function sdkModules(): Promise<{ client: ClientModule; sync: SyncModule }> {
  const client = await import(pathToFileURL(binaries.client).href) as ClientModule
  const sync = await import(pathToFileURL(join(dirname(binaries.client), 'sync.js')).href) as SyncModule
  return { client, sync }
}

export type ConversationView = {
  /** The client currently feeding the projection, if attached. */
  client(): AdeClient | null
  /** Every state the projection reported, with its cause, in order. */
  readonly states: Array<{ state: ProjectionState<ViewSnapshot>; cause: ProjectionCause }>
  /** The last reported state. */
  latest(): ProjectionState<ViewSnapshot> | null
  /** How many snapshots were requested from the daemon. */
  fetches(): number
  /** Frames forwarded to the projection, in order. */
  readonly forwarded: SyncFrame[]
  /** Hold the next snapshot reply until `release` is called; resolves once that snapshot has been read from the daemon. */
  holdNextSnapshot(): { read: Promise<ViewSnapshot>; release: () => void }
  /** Stop the client, as a closed connection or view does; the projection keeps its last state. */
  detach(): void
  /** Start a new client on `profile` and feed the projection from it. */
  attach(profile: ScratchProfile): Promise<AdeClient>
  /** Wait until the projection is current and `match` accepts its snapshot. */
  settle(match: (snapshot: ViewSnapshot) => boolean, timeout?: number): Promise<ViewSnapshot>
  /** Stop the projection and the client. */
  dispose(): void
  /** True after dispose. */
  readonly disposed: boolean
}

/**
 * Open a view of `conversationId` on `profile`. The projection starts at
 * once; call `dispose()` before the test ends.
 */
export async function openConversationView(profile: ScratchProfile, conversationId: string): Promise<ConversationView> {
  const { client: clientModule, sync } = await sdkModules()
  const states: ConversationView['states'] = []
  const forwarded: SyncFrame[] = []
  const listeners = new Set<(frame: SyncFrame) => void>()
  let current: AdeClient | null = null
  let unsubscribeClient: (() => void) | null = null
  let fetches = 0
  let held: { read: (value: ViewSnapshot) => void; gate: Promise<void> } | null = null
  let disposed = false
  let stopProjection: () => void = () => undefined
  let snapshotProfile = profile

  const attach = async (target: ScratchProfile): Promise<AdeClient> => {
    const next = new clientModule.AdeClient(target.socket)
    snapshotProfile = target
    unsubscribeClient = next.subscribeFeed((frame) => {
      forwarded.push(frame as SyncFrame)
      for (const listener of listeners) listener(frame as SyncFrame)
    })
    current = next
    next.start()
    await expect.poll(() => next.getState().status, { timeout: 20_000, message: 'the SDK client to connect' }).toBe('connected')
    return next
  }
  const detach = () => {
    unsubscribeClient?.()
    unsubscribeClient = null
    current?.stop()
    current = null
  }

  await attach(profile)
  stopProjection = sync.startConversationProjection<ViewSnapshot['conversation'], ViewMessage, unknown>({
    conversationId,
    fetchSnapshot: async (id, limit) => {
      fetches += 1
      const snapshot = await snapshotProfile.call('conversation.get', { conversation_id: id, limit }) as unknown as ViewSnapshot
      const hold = held
      held = null
      if (hold) {
        hold.read(snapshot)
        await hold.gate
      }
      return snapshot
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onState: (state, cause) => { states.push({ state, cause }) },
  })

  const view: ConversationView = {
    client: () => current,
    states,
    latest: () => states.at(-1)?.state ?? null,
    fetches: () => fetches,
    forwarded,
    holdNextSnapshot() {
      let release!: () => void
      const gate = new Promise<void>((resolveGate) => { release = resolveGate })
      let read!: (value: ViewSnapshot) => void
      const readPromise = new Promise<ViewSnapshot>((resolveRead) => { read = resolveRead })
      held = { read, gate }
      return { read: readPromise, release }
    },
    detach,
    attach,
    async settle(match, timeout = 30_000) {
      let found: ViewSnapshot | null = null
      await expect.poll(() => {
        const state = view.latest()
        found = state?.status === 'current' && state.snapshot && match(state.snapshot) ? state.snapshot : null
        return found !== null
      }, { timeout, message: 'the projection to settle' }).toBe(true)
      return found!
    },
    dispose() {
      disposed = true
      stopProjection()
      detach()
    },
    get disposed() { return disposed },
  }
  return view
}

/** A comparable digest of a snapshot: status, and each message's ID, sequence and text. */
export function viewDigest(snapshot: { conversation: { status: string }; messages: unknown[] }) {
  return {
    status: snapshot.conversation.status,
    messages: (snapshot.messages as ViewMessage[]).map((message) => ({ id: message.id, sequence: message.sequence,
      text: message.text ?? null })),
  }
}

export type { ClientState }
