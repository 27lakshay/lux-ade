import type { Catalog, ClientState, FeedFrame } from '@ade/client'
import type { AdeHost } from '../../../shared/bridge'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import type { ConversationOperation } from '../../../shared/bridge/operations'

// A fake window.adeHost for renderer tests: tests push client states and feed frames, and answer
// requests, without Electron or a daemon.

/** Answers a request. Tests may answer with partial replies, so replies are not checked here. */
type Request = (op: ConversationOperation, fields: unknown) => Promise<unknown>

export interface FakeHost {
  host: Pick<AdeHost, 'profiles' | 'conversations'>
  pushClientState(state: ClientState): void
  /** Delivers a feed frame. Tests may push partial frames, so frames are not checked here. */
  pushFrame(frame: unknown): void
  setClientState(state: ClientState): void
  requests: { op: ConversationOperation; fields: unknown }[]
}

/** A catalog as a test writes it: the lists it leaves out are empty. */
export type CatalogFixture = Pick<Catalog, 'workspaces' | 'conversations'> & Partial<Catalog>

/** A complete catalog from a fixture. */
export const fullCatalog = (catalog: CatalogFixture): Catalog => ({
  projects: [],
  terminals: [],
  windows: [],
  ...catalog,
})

export function clientState({
  catalog = null,
  ...overrides
}: Partial<Omit<ClientState, 'catalog'>> & { catalog?: CatalogFixture | null } = {}): ClientState {
  return {
    sequence: 1,
    status: 'connected',
    detail: '',
    bootId: 'boot-1',
    revision: 1,
    ...overrides,
    catalog: catalog && fullCatalog(catalog),
  }
}

export function createFakeHost(respond: Request = async () => ({})): FakeHost {
  let current = clientState({ status: 'connecting', sequence: 0 })
  const clientListeners = new Set<(state: ClientState) => void>()
  const feedListeners = new Set<(frame: FeedFrame) => void>()
  const requests: FakeHost['requests'] = []
  const unsupported = (): never => {
    throw new Error('Not supported by the fake host')
  }
  const listen =
    <T>(listeners: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  return {
    host: {
      profiles: {
        getState: unsupported,
        list: unsupported,
        create: unsupported,
        select: unsupported,
        onState: () => () => undefined,
        getClientState: async () => current,
        onClientState: listen(clientListeners),
      },
      conversations: {
        // Like the real IPC boundary, the fake trusts the test's reply to match the operation.
        request: (async (op: ConversationOperation, fields: unknown) => {
          requests.push({ op, fields })
          return respond(op, fields)
        }) as ConversationsBridge['request'],
        listPendingSends: unsupported,
        exportSendJournal: unsupported,
        importSendJournal: unsupported,
        onFeedFrame: listen(feedListeners),
        onDraftError: () => () => undefined,
      },
    },
    pushClientState: (state) => {
      current = state
      for (const listener of clientListeners) listener(state)
    },
    pushFrame: (frame) => {
      // Like the stream bridge, the fake trusts the frame; the SDK checks real ones.
      for (const listener of feedListeners) listener(frame as FeedFrame)
    },
    setClientState: (state) => {
      current = state
    },
    requests,
  }
}

/** Resolves after the next animation frame has run. */
export const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
