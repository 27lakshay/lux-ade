import type { CatalogProject, ClientState, Conversation, Terminal, Workspace } from '@ade/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AdeHost } from '../../../shared/bridge'
import { latestPerFrame } from './frame-batch'

// The daemon connection and catalog, normalized by ID. Fed by the client state main publishes, at
// most once per animation frame. A record that did not change keeps its object identity, so a
// component that selects one workspace or conversation re-renders only when that record changes.

export interface DaemonState {
  status: ClientState['status']
  detail: string
  bootId: string | null
  revision: number | null
  workspaceIds: string[]
  workspaces: Record<string, Workspace>
  conversationIds: string[]
  conversations: Record<string, Conversation>
  /** Every workspace's terminals by ID: kind, title, status and whether a command is running. */
  terminals: Record<string, Terminal>
  /** Every project (a repository or a folder) by ID, as workspaces name it in `project_id`. */
  projects: Record<string, CatalogProject>
}

export type DaemonStore = StoreApi<DaemonState>

const initialState: DaemonState = {
  status: 'unconfigured',
  detail: '',
  bootId: null,
  revision: null,
  workspaceIds: [],
  workspaces: {},
  conversationIds: [],
  conversations: {},
  terminals: {},
  projects: {},
}

function sameRecord(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous) === JSON.stringify(next)
}

function normalize<T extends { id: string }>(
  items: T[],
  previousIds: string[],
  previous: Record<string, T>,
): { ids: string[]; byId: Record<string, T> } {
  const byId: Record<string, T> = {}
  const ids = items.map((item) => {
    const kept = previous[item.id]
    byId[item.id] = kept && sameRecord(kept, item) ? kept : item
    return item.id
  })
  const sameOrder = ids.length === previousIds.length && ids.every((id, index) => id === previousIds[index])
  return { ids: sameOrder ? previousIds : ids, byId }
}

/** Applies one client state to the store's current state. */
function reduceClientState(state: DaemonState, client: ClientState): DaemonState {
  const workspaces = normalize(client.catalog?.workspaces ?? [], state.workspaceIds, state.workspaces)
  const conversations = normalize(client.catalog?.conversations ?? [], state.conversationIds, state.conversations)
  const terminals = normalize(client.catalog?.terminals ?? [], [], state.terminals)
  const projects = normalize(client.catalog?.projects ?? [], [], state.projects)
  return {
    status: client.status,
    detail: client.detail,
    bootId: client.bootId,
    revision: client.revision,
    workspaceIds: workspaces.ids,
    workspaces: workspaces.byId,
    conversationIds: conversations.ids,
    conversations: conversations.byId,
    terminals: terminals.byId,
    projects: projects.byId,
  }
}

/** Creates the store and keeps it current; call `stop` to unsubscribe. */
export function createDaemonStore(host: Pick<AdeHost, 'profiles'>): { store: DaemonStore; stop: () => void } {
  const store = createStore<DaemonState>(() => initialState)
  const apply = (client: ClientState): void => store.setState((state) => reduceClientState(state, client), true)
  // The first read can resolve after a newer pushed state; use it only if nothing was pushed yet.
  // (Sequence numbers cannot order them: a profile switch starts a new client at zero.)
  let pushed = false
  const applyPerFrame = latestPerFrame(apply)
  const stop = host.profiles.onClientState((client) => {
    pushed = true
    applyPerFrame(client)
  })
  void host.profiles.getClientState().then((client) => {
    if (!pushed) apply(client)
  })
  return { store, stop }
}
